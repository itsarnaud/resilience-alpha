"""Classify observed ML anomalies and persist one incident per active episode."""
from contextlib import closing
from datetime import datetime, timedelta
import json
from pathlib import Path
import re
import sqlite3

from resilience_alpha_ai.anomaly_detection.auth_log_adapter import parse_auth_log
from resilience_alpha_ai.anomaly_detection.delivery import deliver_pending
from resilience_alpha_ai.anomaly_detection.episodes import EpisodeTracker
from resilience_alpha_ai.anomaly_detection.features import build_features
from resilience_alpha_ai.anomaly_detection.incidents import build_incident
from resilience_alpha_ai.anomaly_detection.loki_parser import decode_log_line, parse_loki_response
from resilience_alpha_ai.anomaly_detection.outbox import IncidentOutbox
from resilience_alpha_ai.anomaly_detection.runtime import analyze_payload


class IncidentPipeline:
    def __init__(self, path: Path, artifact: dict, *, mode='preview', client=None):
        if mode not in {'preview', 'deliver'}:
            raise ValueError('Mode must be preview or deliver')
        if mode == 'deliver':
            if artifact.get('status') != 'validated' or artifact.get('threshold_status', 'model_default') == 'provisional_not_validated':
                raise ValueError('Live delivery requires a validated model and non-provisional threshold')
            if client is None:
                raise ValueError('Delivery client required')
        elif client is not None:
            raise ValueError('Preview mode cannot use a delivery client')
        self.mode, self.artifact, self.client = mode, artifact, client
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pipeline_mode (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL)')
            existing=db.execute('SELECT mode FROM pipeline_mode WHERE id=1').fetchone()
            if existing and existing[0]!=mode:
                raise ValueError('Preview and delivery databases must remain separate')
            if not existing:
                # Never adopt incidents from an unknown older queue.
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='incidents'").fetchone():
                    raise ValueError('Unmarked existing incident database; use a new pipeline database')
                db.execute('INSERT INTO pipeline_mode VALUES (1, ?)',(mode,))
        self.tracker=EpisodeTracker(path)
        self.outbox=IncidentOutbox(path)

    def close(self):
        self.tracker.close()
        self.outbox.close()

    def flush(self, now=None):
        if self.mode=='preview':
            return {'accepted':0,'deferred':0,'enabled':False}
        return {**deliver_pending(self.outbox,self.client,now=now),'enabled':True}

    def process(self, payload, *, end: datetime, query: str):
        if not isinstance(query,str) or not query.strip() or len(query)>1500:
            raise ValueError('Provide a non-empty bounded source LogQL selector')
        report=analyze_payload(payload,self.artifact,end)
        parsed=parse_loki_response(payload)
        start=end-timedelta(seconds=self.artifact['window_seconds'])
        features=build_features(parsed['events'],window_end=end,window_seconds=self.artifact['window_seconds'])
        by_ip={row['source_ip']:row for row in features}
        # Preserve raw source representations in the retrievable evidence query.
        raw_ips={}
        for stream in payload['data']['result']:
            for _,line in stream['values']:
                record=decode_log_line(line)
                event=parse_auth_log(record)
                if event and event.outcome=='failure' and start<event.timestamp<=end:
                    raw_ips.setdefault(event.source_ip,set()).add(record['ip'])
        queued=[]
        for prediction in report['predictions']:
            if not prediction['is_anomaly']:
                continue
            ip=prediction['source_ip'];row=by_ip[ip]
            # ML must flag the window; these conditions classify its observed evidence.
            kind='BRUTE_FORCE' if row['failure_count']>=5 and row['failure_ratio']>=0.8 else 'UNKNOWN_ANOMALY'
            episode=self.tracker.get_or_create(ip,kind)
            key=f'{kind}:auth:{episode}'
            existing=self.outbox.get_payload(key)
            if existing is not None:
                queued.append({'dedup_key':key,'queued':False,'payload':existing})
                continue
            evidence=[]
            if kind=='BRUTE_FORCE':
                pattern='|'.join(re.escape(value) for value in sorted(raw_ips[ip]))
                evidence_query=query+' | json | event="login_failed" | ip=~'+json.dumps(pattern)
                if len(evidence_query)>2000:
                    raise ValueError('Evidence query exceeds incident API limit')
                evidence=[{'kind':'logql','query':evidence_query,'value':row['failure_count']}]
            incident=build_incident(episode_id=episode,source_ip=ip,normalized_score=prediction['score'],detected_at=end,evidence=evidence,incident_type=kind)
            incident['stats']={'attempts':row['attempt_count'],'failures':row['failure_count'],'window_seconds':self.artifact['window_seconds']}
            accounts=sorted({e.account_id for e in parsed['events'] if e.source_ip==ip and e.outcome=='failure' and start<e.timestamp<=end})
            if len(accounts)>100 or any(len(value)>254 for value in accounts):
                raise ValueError('Observed targets exceed incident contract limits')
            incident['targets']=accounts
            queued.append({'dedup_key':key,'queued':self.outbox.enqueue(incident),'payload':incident})
        return {'observation':report,'mode':self.mode,'incidents':queued,
                'evidence_window':{'start':start.isoformat(),'end':end.isoformat()},
                'note':'Anomaly episodes remain open until explicitly closed after confirmed recovery.'}
