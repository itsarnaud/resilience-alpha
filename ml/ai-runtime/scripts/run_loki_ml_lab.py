"""Exercise real local auth logs through Loki and ML; never send remediation."""
import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import sys
import time
import uuid


def ns(value):
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = value.astimezone(timezone.utc) - epoch
    return str((delta.days * 86400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1000)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True, type=Path)
    root = parser.parse_args().project.resolve()
    sys.path.insert(0, str(root / 'src'))
    import httpx
    from resilience_alpha_ai.anomaly_detection.model_loader import load_model
    from resilience_alpha_ai.anomaly_detection.runtime import analyze_payload

    artifact = load_model(root/'models/auth_isolation_forest_synthetic.joblib', root/'models/auth_threshold_candidate.json')
    if artifact['window_seconds'] != 60:
        raise SystemExit('Lab requires the existing 60-second model')
    session = str(uuid.uuid4())
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    directory = root/'data'/'raw'/('loki_lab_'+stamp)
    directory.mkdir(parents=True, exist_ok=False)
    with httpx.Client(timeout=10, trust_env=False) as client:
        client.get('http://127.0.0.1:3100/ready').raise_for_status()
        client.get('http://127.0.0.1:3001/readyz').raise_for_status()
        start = datetime.now(timezone.utc)
        end = start + timedelta(seconds=60)
        clock = time.monotonic()
        print('Generating 30 failed logins against the local demo account over 55 seconds.', flush=True)
        statuses = []
        for index in range(30):
            response = client.post('http://127.0.0.1:3001/v1/login', json={
                'email':'customer@example.test', 'password':'WrongPassword123',
            })
            statuses.append(response.status_code)
            if response.status_code != 401:
                raise SystemExit(f'Unexpected login HTTP {response.status_code}; no scoring')
            if (index+1) % 10 == 0:
                print(f'Logins completed: {index+1}/30', flush=True)
            time.sleep(max(0, clock + (index+1)*55/30 - time.monotonic()))
        time.sleep(max(0, clock+60.5-time.monotonic()))
        logs = subprocess.run(['docker','logs','--since',start.isoformat(),'--until',end.isoformat(),'resilience-ai-lab-auth'], capture_output=True, check=True, timeout=20)
        events = []
        for line in (logs.stdout+b'\n'+logs.stderr).decode('utf-8').splitlines():
            if not line.strip():continue
            try:record=json.loads(line)
            except json.JSONDecodeError:continue
            if record.get('service')=='auth' and record.get('event')=='login_failed' and record.get('email')=='customer@example.test':
                event_time=datetime.fromisoformat(record['time'].replace('Z','+00:00'))
                if start < event_time <= end:
                    events.append((event_time,record))
        if len(events)!=30 or len({record.get('request_id') for _,record in events})!=30:
            raise SystemExit(f'Expected 30 unique real login logs; found {len(events)}. No scoring.')
        events.sort(key=lambda pair:pair[0])
        raw = ''.join(json.dumps(record, ensure_ascii=False)+'\n' for _,record in events)
        (directory/'auth.jsonl').write_text(raw,encoding='utf-8')
        values = [[ns(t),json.dumps(record,ensure_ascii=False)] for t,record in events]
        pushed = client.post('http://127.0.0.1:3100/loki/api/v1/push', json={'streams':[{
            'stream':{'container':'resilience-ai-lab-auth','lab_session':session}, 'values':values,
        }]})
        pushed.raise_for_status()
        query = '{container="resilience-ai-lab-auth",lab_session="'+session+'"}'
        params = dict(query=query,start=ns(start),end=ns(end),limit=100,direction='forward')
        for attempt in range(10):
            response=client.get('http://127.0.0.1:3100/loki/api/v1/query_range',params=params)
            response.raise_for_status();payload=response.json()
            if payload.get('status')!='success' or payload.get('data',{}).get('resultType')!='streams':
                raise SystemExit('Unexpected Loki query response')
            count=sum(len(stream['values']) for stream in payload['data']['result'])
            if count==30:break
            time.sleep(1)
        else:raise SystemExit(f'Loki returned {count}/30 logs; no scoring')
        (directory/'loki_snapshot.json').write_text(json.dumps(payload,indent=2),encoding='utf-8')
        report=analyze_payload(payload,artifact,end)
        if report['events_in_window']!=30:
            raise SystemExit('Parsed event count mismatch')
        report['lab']={'session':session,'query':query,'window_start':start.isoformat(),'window_end':end.isoformat(),
                       'input':'real auth-service logs manually pushed to local Loki',
                       'collection':'bounded snapshot, not continuous ingestion',
                       'planned_logins':30,'http_statuses':statuses,
                       'limitations':['Local Docker gateway IP; separate attacker attribution not tested.',
                                      'Prototype model; no automatic remediation validated.']}
        output=root/'data'/'processed'/('loki_ml_lab_'+stamp+'.json')
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf-8')
        print('Real auth logs -> Loki -> parser -> feature windows -> ML: completed',flush=True)
        for result in report['predictions']:
            print(json.dumps({key:result[key] for key in ('source_ip','score','threshold','is_anomaly','model_status')}),flush=True)
        print('Report:',output,flush=True)
        print('No incidents sent. No IP blocked. Continuous collection still pending.',flush=True)

if __name__=='__main__':main()
