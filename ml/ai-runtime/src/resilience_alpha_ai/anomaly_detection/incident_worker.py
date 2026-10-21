"""Run Loki -> ML -> persistent incidents; preview mode is the default."""
import argparse
from contextlib import ExitStack
from datetime import datetime,timedelta,timezone
import json
import os
from pathlib import Path
import threading
import signal

import httpx
from resilience_alpha_ai.anomaly_detection.model_loader import load_model
from resilience_alpha_ai.anomaly_detection.loki_client import fetch_logs
from resilience_alpha_ai.anomaly_detection.incident_pipeline import IncidentPipeline
from resilience_alpha_ai.anomaly_detection.remediation_client import RemediationClient
from resilience_alpha_ai.anomaly_detection.observation_store import ObservationStore


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    src=parser.add_mutually_exclusive_group(required=True)
    src.add_argument('--loki-url');src.add_argument('--snapshot',type=Path)
    parser.add_argument('--query',required=True)
    parser.add_argument('--window-end')
    parser.add_argument('--model',required=True,type=Path)
    parser.add_argument('--threshold-config',type=Path)
    parser.add_argument('--mode',choices=['preview','deliver'],default='preview')
    parser.add_argument('--pipeline-db',required=True,type=Path)
    parser.add_argument('--observation-db',type=Path)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--once',action='store_true')
    args=parser.parse_args()
    if args.snapshot and not args.window_end:parser.error('Snapshot requires --window-end')
    if args.loki_url and args.window_end:parser.error('Live worker uses current time')
    if args.report and args.report.exists():parser.error('Report already exists; choose a new filename')
    artifact=load_model(args.model,args.threshold_config)
    stop=threading.Event()
    signal.signal(signal.SIGINT,lambda *_:stop.set())
    signal.signal(signal.SIGTERM,lambda *_:stop.set())
    with ExitStack() as stack:
        client=None
        if args.mode=='deliver':
            if artifact.get('status')!='validated' or artifact.get('threshold_status')=='provisional_not_validated':
                parser.error('Current model/threshold is provisional: live delivery blocked')
            required=['DETECTOR_AUTH_URL','REMEDIATION_URL','DETECTOR_CLIENT_ID','DETECTOR_CLIENT_SECRET']
            if any(not os.getenv(key) for key in required):parser.error('Missing service endpoint or credential environment variables')
            http=stack.enter_context(httpx.Client(timeout=10,trust_env=False))
            client=RemediationClient(http,*(os.environ[key] for key in required))
        pipeline=IncidentPipeline(args.pipeline_db,artifact,mode=args.mode,client=client)
        stack.callback(pipeline.close)
        while not stop.is_set():
            result=None
            try:
                end=datetime.fromisoformat(args.window_end.replace('Z','+00:00')) if args.snapshot else datetime.now(timezone.utc)-timedelta(seconds=5)
                payload=json.loads(args.snapshot.read_text(encoding='utf-8-sig')) if args.snapshot else fetch_logs(args.loki_url,args.query,end-timedelta(seconds=artifact['window_seconds']+15),end)
                result=pipeline.process(payload,end=end,query=args.query)
                if args.observation_db:ObservationStore(args.observation_db).save(result['observation'])
            except Exception as error:
                print(json.dumps({'status':'collection_or_scoring_error','error_type':type(error).__name__,'mode':args.mode}),flush=True)
                if args.snapshot or args.once:raise SystemExit(1) from None
            # Delivery errors such as 403 stop the worker; transient outages persist for retry.
            delivery=pipeline.flush()
            if result is not None:
                result['delivery']=delivery
                if args.report:
                    args.report.parent.mkdir(parents=True,exist_ok=True)
                    with args.report.open('x',encoding='utf-8') as stream:json.dump(result,stream,indent=2,allow_nan=False)
                print(json.dumps({'mode':args.mode,'events':result['observation']['events_in_window'],'new_incidents':sum(i['queued'] for i in result['incidents']),'existing_incidents':sum(not i['queued'] for i in result['incidents']),'delivery':delivery}),flush=True)
            if args.snapshot or args.once:break
            stop.wait(5)

if __name__=='__main__':main()
