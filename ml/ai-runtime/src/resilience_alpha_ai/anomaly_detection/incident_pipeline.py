"""Classify observed ML anomalies and persist one incident per active episode."""
from contextlib import closing
from datetime import datetime, timedelta
import json
import os
from ipaddress import ip_address
from pathlib import Path
import re
import sqlite3

from resilience_alpha_ai.anomaly_detection.auth_log_adapter import parse_auth_log
from resilience_alpha_ai.anomaly_detection.delivery import deliver_pending
from resilience_alpha_ai.anomaly_detection.episodes import EpisodeTracker
from resilience_alpha_ai.anomaly_detection.features import build_features
from resilience_alpha_ai.anomaly_detection.incidents import build_incident
from resilience_alpha_ai.anomaly_detection.loki_parser import decode_log_line, parse_loki_response
from resilience_alpha_ai.anomaly_detection.model_loader import require_validated_delivery
from resilience_alpha_ai.anomaly_detection.outbox import IncidentOutbox
from resilience_alpha_ai.anomaly_detection.runtime import analyze_payload


class IncidentPipeline:
    def __init__(self, path: Path, artifact: dict, *, mode='preview', client=None):
        if mode not in {'preview', 'deliver'}:
            raise ValueError('Mode must be preview or deliver')
        if mode == 'deliver':
            require_validated_delivery(artifact)
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
        skipped=[]
        still_anomalous=set()
        for prediction in report['predictions']:
            if not prediction['is_anomaly']:
                continue
            ip=prediction['source_ip'];row=by_ip[ip]
            # ML must flag the window; these conditions classify its observed evidence.
            kind='BRUTE_FORCE' if row['failure_count']>=5 and row['failure_ratio']>=0.8 else 'UNKNOWN_ANOMALY'
            still_anomalous.add((ip,kind))
            if self.mode == 'deliver':
                address = ip_address(ip)
                protected = {'192.168.166.1', '192.168.137.1', '192.168.65.1', '172.17.0.1'}
                protected.update(value.strip() for value in os.getenv('DETECTOR_PROTECTED_IPS', '').split(',') if value.strip())
                if kind != 'BRUTE_FORCE' or address.is_loopback or address.is_unspecified or address.is_multicast or ip in protected:
                    skipped.append({'source_ip':ip, 'type':kind, 'reason':'not_eligible_for_automatic_block'})
                    continue
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
        # No feedback channel exists from remediation back to this worker to signal
        # confirmed recovery, so an episode cannot stay open "until closed" the way the
        # original design intended: nothing would ever close it, and the same IP could
        # only ever trigger one incident for the lifetime of this pipeline database
        # (e.g. a manual unblock followed by a repeat attack would be silently
        # ignored). Instead, close any open episode whose IP is no longer flagged
        # anomalous in this window: a continuing burst keeps re-appearing here every
        # poll and stays deduplicated, while a burst that genuinely stops (blocked by
        # the WAF, or the attacker gives up) lets the next distinct burst from the
        # same IP open a fresh episode and fire a new incident.
        for source_ip,incident_type,episode_id in self.tracker.open_episodes():
            if (source_ip,incident_type) not in still_anomalous:
                self.tracker.close_episode(source_ip,episode_id,incident_type)
        return {'observation':report,'mode':self.mode,'incidents':queued,'skipped':skipped,
                'evidence_window':{'start':start.isoformat(),'end':end.isoformat()}}
