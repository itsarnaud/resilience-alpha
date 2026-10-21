"""Evaluate a frozen model/threshold on eight fresh local auth-service windows."""
import argparse
from datetime import datetime,timedelta,timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

# Scenarios are fixed before collection. No threshold tuning is performed.
SCENARIOS=[('normal',2,0),('normal',5,1),('normal',9,2),('normal',12,1),
           ('normal',6,2),('attack',20,20),('attack',8,8),('attack',40,40)]


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path,data):
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,indent=2,allow_nan=False),encoding='utf-8')
    temporary.replace(path)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project',required=True,type=Path)
    root=parser.parse_args().project.resolve()
    sys.path.insert(0,str(root/'src'))
    import httpx
    from resilience_alpha_ai.anomaly_detection.model_loader import load_model
    from resilience_alpha_ai.anomaly_detection.auth_log_adapter import parse_auth_log
    from resilience_alpha_ai.anomaly_detection.features import build_features
    from resilience_alpha_ai.anomaly_detection.evaluate import evaluate

    model=root/'models/auth_isolation_forest_synthetic.joblib'
    config=root/'models/auth_threshold_candidate.json'
    hashes=(digest(model),digest(config))
    artifact=load_model(model,config)
    if artifact['window_seconds']!=60:raise SystemExit('Campaign requires 60-second windows')
    session=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    folder=root/'data'/'raw'/('evaluation_campaign_'+session);folder.mkdir(parents=True,exist_ok=False)
    processed=root/'data'/'processed';processed.mkdir(parents=True,exist_ok=True)
    dataset=processed/('evaluation_campaign_'+session+'.json')
    output=processed/('evaluation_campaign_report_'+session+'.json')
    manifest={'session_id':session,'scenarios':[dict(label=kind,attempts=count,failures=failed) for kind,count,failed in SCENARIOS],
              'window_seconds':60,'environment':'local_auth_service_without_waf','model_sha256':hashes[0],
              'threshold_config_sha256':hashes[1],'threshold':artifact['decision_threshold'],
              'completed_windows':0,'status':'collecting'}
    write_json(folder/'manifest.json',manifest)
    rows=[]
    print('Eight fresh windows; about 8 minutes. Progress appears every 10 requests or each window.',flush=True)
    print('Fixed threshold:',artifact['decision_threshold'],flush=True)
    print('Output folder:',folder,flush=True)
    with httpx.Client(timeout=10,trust_env=False) as client:
        client.get('http://127.0.0.1:3001/readyz').raise_for_status()
        for number,(kind,attempts,mistakes) in enumerate(SCENARIOS,1):
            start=datetime.now(timezone.utc);end=start+timedelta(seconds=60);clock=time.monotonic()
            statuses=[]
            print(f'Window {number}/8: {kind}; {attempts} attempts, {mistakes} intentional password failures.',flush=True)
            for index in range(attempts):
                response=client.post('http://127.0.0.1:3001/v1/login',json={'email':'customer@example.test','password':'WrongPassword123' if index<mistakes else 'DemoCustomer123'})
                expected=401 if index<mistakes else 200
                statuses.append(response.status_code)
                if response.status_code!=expected:raise SystemExit(f'Unexpected HTTP {response.status_code}; completed windows preserved. Do not treat campaign as complete.')
                if (index+1)%10==0:print(f'  Requests {index+1}/{attempts}',flush=True)
                time.sleep(max(0,clock+(index+1)*55/attempts-time.monotonic()))
            time.sleep(max(0,clock+60.5-time.monotonic()))
            logs=subprocess.run(['docker','logs','--since',start.isoformat(),'--until',end.isoformat(),'resilience-ai-lab-auth'],capture_output=True,check=True,timeout=20)
            events=[];records=[];identities=set()
            for line in (logs.stdout+b'\n'+logs.stderr).decode('utf-8').splitlines():
                if not line.strip():continue
                try:record=json.loads(line)
                except json.JSONDecodeError:continue
                if record.get('service')!='auth' or record.get('event') not in ('login_failed','login_succeeded') or record.get('email')!='customer@example.test':continue
                event=parse_auth_log(record)
                if event is None or not start<event.timestamp<=end:continue
                key=record.get('request_id')
                if not isinstance(key,str) or not key:raise SystemExit('Missing request identity; scoring stopped')
                if key in identities:raise SystemExit('Duplicate request identity; scoring stopped')
                identities.add(key);events.append(event);records.append(record)
            (folder/f'{number:02d}_auth.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in records),encoding='utf-8')
            write_json(folder/f'{number:02d}_scenario.json',{'kind':kind,'start':start.isoformat(),'end':end.isoformat(),'planned_attempts':attempts,'planned_failures':mistakes,'http_statuses':statuses})
            features=build_features(events,window_end=end)
            if len(features)!=1 or features[0]['attempt_count']!=attempts or features[0]['failure_count']!=mistakes:
                raise SystemExit('Observed logs differ from scenario; partial data preserved, no complete report')
            row=features[0];row.update(label=kind=='attack',session_id=session,purpose='evaluation',scenario_number=number,data_origin='platform')
            rows.append(row);write_json(dataset,rows)
            manifest['completed_windows']=number;write_json(folder/'manifest.json',manifest)
            print(f'Window {number}/8 saved.',flush=True)
    if (digest(model),digest(config))!=hashes:raise SystemExit('Model or threshold changed during campaign; no final evaluation')
    report=evaluate(artifact,rows)
    report.update(evaluation_data_origin='platform',environment=manifest['environment'],
                  model_sha256=hashes[0],threshold_config_sha256=hashes[1],evaluation_sha256=digest(dataset),
                  decision_threshold=artifact['decision_threshold'],threshold_status=artifact['threshold_status'],
                  limitations=['Eight controlled windows on one local account and one Docker-gateway source.',
                               'Labels reflect scripted normal/attack scenarios, not independent security adjudication.',
                               'Model remains trained on synthetic data; this campaign does not change validation status.',
                               'No WAF, separate attacker machine, automatic remediation or detection-latency validation.',
                               'Earlier calibration and evaluation sessions were not reused in this dataset.'])
    write_json(output,report);manifest['status']='complete';write_json(folder/'manifest.json',manifest)
    summary={key:value for key,value in report.items() if key not in ('predictions','limitations')}
    print(json.dumps(summary,indent=2),flush=True)
    print('Dataset:',dataset,flush=True);print('Report:',output,flush=True)
    print('No threshold tuning. No model status changed. No remediation requests sent.',flush=True)

if __name__=='__main__':main()
