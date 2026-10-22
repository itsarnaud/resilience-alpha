"""Reproduce the controlled-lab release using the frozen Oct 22 Loki capture.

Low-activity windows are acceptance cases, not independently labelled benign
traffic: some follow attack bursts. No production accuracy is claimed.
"""
import argparse
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
import joblib
from resilience_alpha_ai.anomaly_detection.model_loader import load_model, require_validated_delivery
from resilience_alpha_ai.anomaly_detection.runtime import analyze_payload

SOURCE_SHA = '37c0d2c8ba16af30af29300732e19c6c23842f572b32f82b3ce96caee0f72237'
CALIBRATION = ['09:17', '09:26', '09:41']
HOLDOUT = {
 '09:21': True, '09:27': False, '09:30': True, '09:31': False,
 '09:38': False, '09:40': True, '09:42': True, '09:50': True,
 '10:00': False, '10:23': False, '10:25': True, '10:26': True,
 '10:27': True, '10:28': False, '10:51': False, '10:52': False,
}

def evaluate(payload, artifact, minute):
    end = datetime.fromisoformat('2026-10-22T'+minute+':00+00:00')+timedelta(minutes=1)
    predictions = analyze_payload(payload, artifact, end)['predictions']
    if len(predictions) != 1:
        raise ValueError('Expected exactly one source in acceptance window '+minute)
    return predictions[0]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--publish', action='store_true', help='Export only after all acceptance checks pass')
    args=parser.parse_args();root=args.root
    content=args.input.read_bytes()
    if hashlib.sha256(content).hexdigest()!=SOURCE_SHA:
        raise ValueError('This release requires the exact reviewed Oct 22 capture')
    payload=json.loads(content.decode('utf-8-sig'))
    model_path=root/'models/auth_isolation_forest_synthetic.joblib'
    threshold_path=root/'models/auth_threshold_candidate.json'
    artifact=load_model(model_path,threshold_path)
    calibration=[evaluate(payload,artifact,m) for m in CALIBRATION]
    # Derived only from low-activity calibration cases; no attack scores used.
    threshold=max(p['score'] for p in calibration)+0.01
    candidate={**artifact,'decision_threshold':threshold}
    checks=[]
    for minute, expected in HOLDOUT.items():
        prediction=evaluate(payload,candidate,minute)
        checks.append({'minute_utc':minute,'expected_anomaly':expected,'prediction':prediction})
    if not all(c['prediction']['is_anomaly']==c['expected_anomaly'] for c in checks):
        raise ValueError('Held-out laboratory acceptance failed; files unchanged')
    report={
      'scope':'controlled_authentication_lab', 'source_sha256':SOURCE_SHA,
      'label_basis':'Scenario acceptance: burst windows flag; low-activity and recovery windows do not. Not independent incident ground truth.',
      'calibration_minutes_utc':CALIBRATION,'calibration_margin':0.01,
      'threshold':threshold,'holdout_cases':len(checks),
      'burst_cases':sum(HOLDOUT.values()),'low_activity_cases':sum(not v for v in HOLDOUT.values()),
      'passed':True,'checks':checks,'remediation_sent':False,
      'limitations':['Single selected capture; sparse normal traffic.',
       'Loopback, shared Docker gateway and documentation IPs do not prove real attacker attribution.',
       'No end-to-end WAF execution was performed by this evaluation.',
       'Model remains trained on synthetic data; validation applies only to this workshop lab.'],
    }
    if args.publish:
        # Retain learned estimator and data origin; export reviewed release metadata.
        original=dict(joblib.load(model_path))
        original.update(status='validated',validation_scope='controlled_authentication_lab',
                        validation_source_sha256=SOURCE_SHA,validation_report='reports/validation/ml_lab_release_20261022.json')
        joblib.dump(original,model_path,compress=3)
        digest=hashlib.sha256(model_path.read_bytes()).hexdigest()
        config=json.loads(threshold_path.read_text(encoding='utf-8-sig'))
        config.update(status='validated',threshold=threshold,model_sha256=digest,
                      method='maximum_low_activity_calibration_score_plus_0.01',
                      calibration_windows=len(CALIBRATION),calibration_sha256=SOURCE_SHA,
                      validation_scope='controlled_authentication_lab',validation_source_sha256=SOURCE_SHA)
        threshold_path.write_text(json.dumps(config,indent=2)+'\n',encoding='utf-8')
        require_validated_delivery(load_model(model_path,threshold_path))
        report['model_sha256']=digest
        report_path=root/'reports/validation/ml_lab_release_20261022.json'
        report_path.parent.mkdir(parents=True,exist_ok=True)
        report_path.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
        manifest_path=root/'ARTIFACT_MANIFEST.json'
        manifest=json.loads(manifest_path.read_text(encoding='utf-8-sig'))
        for item in manifest['artifacts']:
            if item['path'] in ['models/auth_isolation_forest_synthetic.joblib','models/auth_threshold_candidate.json']:
                data=(root/item['path']).read_bytes()
                item.update(sha256=hashlib.sha256(data).hexdigest(),size_bytes=len(data),git_included=True)
        manifest_path.write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='checks'},indent=2))

if __name__=='__main__':main()
