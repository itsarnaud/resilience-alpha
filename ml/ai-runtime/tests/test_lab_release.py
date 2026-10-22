"""Exercise the shipped estimator, threshold and authenticated delivery together."""
import json
from pathlib import Path
import tempfile
import unittest
import httpx
from test_incident_pipeline import payload, END, QUERY
from resilience_alpha_ai.anomaly_detection.model_loader import load_model, require_validated_delivery
from resilience_alpha_ai.anomaly_detection.incident_pipeline import IncidentPipeline
from resilience_alpha_ai.anomaly_detection.remediation_client import RemediationClient
from resilience_alpha_ai.anomaly_detection.runtime import analyze_payload

ROOT=Path(__file__).resolve().parents[1]

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.artifact=load_model(ROOT/'models/auth_isolation_forest_synthetic.joblib', ROOT/'models/auth_threshold_candidate.json')

    def test_release_status_and_isolated_failure(self):
        require_validated_delivery(self.artifact)
        self.assertEqual(self.artifact['data_origin'],'synthetic')
        self.assertEqual(self.artifact['validation_scope'],'controlled_authentication_lab')
        self.assertFalse(analyze_payload(payload(1),self.artifact,END)['predictions'][0]['is_anomaly'])
        self.assertTrue(analyze_payload(payload(8),self.artifact,END)['predictions'][0]['is_anomaly'])

    def test_actual_model_to_authenticated_incident_and_restart(self):
        sent=[]
        def server(request):
            if request.url.path=='/v1/token':
                return httpx.Response(200,json={'access_token':'test-token','token_type':'Bearer','expires_in':900})
            self.assertEqual(request.headers['authorization'],'Bearer test-token')
            sent.append(json.loads(request.content))
            return httpx.Response(202,json={'id':'test-incident'})
        with tempfile.TemporaryDirectory() as directory, httpx.Client(transport=httpx.MockTransport(server),trust_env=False) as http:
            client=RemediationClient(http,'http://auth:3000','http://remediation:3000','svc-detector','test-value')
            for attempt in range(2):
                pipeline=IncidentPipeline(Path(directory)/'live.sqlite',self.artifact,mode='deliver',client=client)
                try:
                    report=pipeline.process(payload(8),end=END,query=QUERY)
                    self.assertEqual(report['incidents'][0]['queued'],attempt==0)
                    self.assertEqual(pipeline.flush()['accepted'],1 if attempt==0 else 0)
                finally:pipeline.close()
        self.assertEqual(len(sent),1)
        self.assertEqual(sent[0]['type'],'BRUTE_FORCE')
        self.assertEqual(sent[0]['stats']['failures'],8)
        self.assertGreater(sent[0]['score'],self.artifact['decision_threshold'])
        self.assertTrue(sent[0]['evidence'])

    def test_host_and_shared_gateway_are_observed_but_not_queued(self):
        for ip in ['127.0.0.1','::1','192.168.166.1','192.168.137.1']:
            value=payload(8)
            for pair in value['data']['result'][0]['values']:
                record=json.loads(pair[1]);record['ip']=ip;pair[1]=json.dumps(record)
            with tempfile.TemporaryDirectory() as directory:
                pipeline=IncidentPipeline(Path(directory)/'live.sqlite',self.artifact,mode='deliver',client=object())
                try:
                    report=pipeline.process(value,end=END,query=QUERY)
                    self.assertTrue(report['observation']['predictions'][0]['is_anomaly'])
                    self.assertEqual(report['incidents'],[])
                    self.assertEqual(len(report['skipped']),1)
                finally:pipeline.close()
