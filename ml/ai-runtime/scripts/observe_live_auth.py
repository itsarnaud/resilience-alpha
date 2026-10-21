"""Continuously forward bounded local auth logs to Loki and observe ML scores."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import time


def timestamp_ns(value):
    delta=value-datetime(1970,1,1,tzinfo=timezone.utc)
    return str((delta.days*86400+delta.seconds)*10**9+delta.microseconds*1000)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project',required=True,type=Path)
    args=parser.parse_args();root=args.project.resolve()
    sys.path.insert(0,str(root/'src'))
    import httpx
    from resilience_alpha_ai.anomaly_detection.model_loader import load_model
    from resilience_alpha_ai.anomaly_detection.runtime import analyze_payload
    from resilience_alpha_ai.anomaly_detection.observation_store import ObservationStore
    artifact=load_model(root/'models/auth_isolation_forest_synthetic.joblib',root/'models/auth_threshold_candidate.json')
    session=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    query='{container="resilience-ai-lab-auth",collector_session="'+session+'"}'
    output=root/'data'/'processed'/('live_observation_'+session+'.jsonl');output.parent.mkdir(parents=True,exist_ok=True)
    seen={}
    print('Collecting and scoring every 5 seconds. Ctrl+C stops this worker. No remediation enabled.',flush=True)
    print('Reports:',output,flush=True)
    with httpx.Client(timeout=10,trust_env=False) as client:
        client.get('http://127.0.0.1:3100/ready').raise_for_status()
        while True:
            try:
                now=datetime.now(timezone.utc);cutoff=now-timedelta(seconds=90)
                logs=subprocess.run(['docker','logs','--since',cutoff.isoformat(),'--tail','4000','resilience-ai-lab-auth'],capture_output=True,check=True,timeout=15)
                values=[];pending={}
                for line in (logs.stdout+b'\n'+logs.stderr).decode('utf-8').splitlines():
                    try:record=json.loads(line)
                    except json.JSONDecodeError:continue
                    if record.get('service')!='auth' or record.get('event') not in ('login_failed','login_succeeded'):continue
                    when=datetime.fromisoformat(record['time'].replace('Z','+00:00'))
                    if not cutoff < when <= now:continue
                    key=record.get('request_id')
                    if not isinstance(key,str) or not key:raise ValueError('Auth log missing request_id')
                    canonical=json.dumps(record,sort_keys=True,ensure_ascii=False)
                    if key in seen:
                        if seen[key][1]!=canonical:raise ValueError('Conflicting request_id')
                        continue
                    if key in pending:
                        if pending[key][1]!=canonical:raise ValueError('Conflicting request_id')
                        continue
                    pending[key]=(when,canonical)
                    values.append([timestamp_ns(when),canonical])
                if len(logs.stdout.splitlines())+len(logs.stderr.splitlines())>=4000:
                    raise ValueError('Docker snapshot may be truncated; observation skipped')
                if values:
                    values.sort(key=lambda value:int(value[0]))
                    response=client.post('http://127.0.0.1:3100/loki/api/v1/push',json={'streams':[{'stream':{'container':'resilience-ai-lab-auth','collector_session':session},'values':values}]})
                    response.raise_for_status();seen.update(pending)
                seen={key:value for key,value in seen.items() if value[0]>cutoff}
                end=now-timedelta(seconds=5);start=end-timedelta(seconds=75)
                response=client.get('http://127.0.0.1:3100/loki/api/v1/query_range',params={'query':query,'start':timestamp_ns(start),'end':timestamp_ns(end),'limit':5000,'direction':'forward'})
                response.raise_for_status();payload=response.json()
                if payload.get('status')!='success' or payload.get('data',{}).get('resultType')!='streams':raise ValueError('Unexpected Loki response')
                if sum(len(stream['values']) for stream in payload['data']['result'])>=5000:raise ValueError('Loki snapshot may be truncated')
                report=analyze_payload(payload,artifact,end)
                report['collection']={'kind':'local_docker_logs_bridge','session':session,'query':query,'logs_forwarded':len(values)}
                ObservationStore(root/'.storage'/'observations.sqlite').save(report)
                with output.open('a',encoding='utf-8') as stream:stream.write(json.dumps(report,allow_nan=False)+'\n')
                print(json.dumps({'status':report['status'],'events':report['events_in_window'],'flagged':sum(p['is_anomaly'] for p in report['predictions']),'forwarded':len(values),'remediation_sent':False}),flush=True)
            except KeyboardInterrupt:break
            except Exception as error:
                print(json.dumps({'status':'error','error_type':type(error).__name__,'detail':str(error),'remediation_sent':False}),flush=True)
            try:time.sleep(5)
            except KeyboardInterrupt:break
    print('Observation worker stopped.',flush=True)

if __name__=='__main__':main()
