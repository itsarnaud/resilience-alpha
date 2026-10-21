import json
from datetime import datetime,timezone
from pathlib import Path
import tempfile
import unittest

import httpx
import numpy as np
import sklearn
from resilience_alpha_ai.anomaly_detection.features import FEATURE_NAMES
from resilience_alpha_ai.anomaly_detection.incident_pipeline import IncidentPipeline
from resilience_alpha_ai.anomaly_detection.remediation_client import RemediationClient

class Model:
    offset_=-.5
    def decision_function(self,matrix):return np.full(len(matrix),-.3)
    def predict(self,matrix):return np.full(len(matrix),-1)

def artifact(validated=False):
    return dict(model=Model(),feature_names=list(FEATURE_NAMES),sklearn_version=sklearn.__version__,window_seconds=60,data_origin='synthetic',status='validated' if validated else 'prototype_not_validated')

def payload(count=15):
    return {'status':'success','data':{'resultType':'streams','result':[{'stream':{'container':'auth'},'values':[
        [str(1000+i),json.dumps(dict(service='auth',event='login_failed',time=f'2026-10-21T08:00:{i+1:02d}Z',email='demo@example.test',ip='::ffff:192.0.2.10',request_id=f'req-{i}'))]
        for i in range(count)]}]}}

END=datetime(2026,10,21,8,1,tzinfo=timezone.utc)
QUERY='{container="auth"}'

class PipelineTests(unittest.TestCase):
    def test_classification_targets_stats_and_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            p=IncidentPipeline(Path(folder)/'preview.db',artifact())
            try:
                r=p.process(payload(),end=END,query=QUERY);i=r['incidents'][0]['payload']
                self.assertEqual(i['type'],'BRUTE_FORCE');self.assertEqual(i['stats'],dict(attempts=15,failures=15,window_seconds=60))
                self.assertEqual(i['targets'],['demo@example.test']);self.assertEqual(i['source_ip'],'192.0.2.10')
                self.assertEqual(i['evidence'][0]['value'],15);self.assertIn('login_failed',i['evidence'][0]['query'])
                self.assertFalse(p.flush()['enabled'])
            finally:p.close()
    def test_restart_and_overlapping_windows_preserve_first_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'preview.db';p=IncidentPipeline(path,artifact())
            try:first=p.process(payload(5),end=END,query=QUERY)['incidents'][0]['payload']
            finally:p.close()
            p=IncidentPipeline(path,artifact())
            try:
                second=p.process(payload(15),end=END,query=QUERY)['incidents'][0]
                self.assertFalse(second['queued']);self.assertEqual(second['payload'],first)
                self.assertEqual(len(p.outbox.ready()),1)
            finally:p.close()
    def test_ml_flag_required_and_low_failures_not_brute_force(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            p=IncidentPipeline(Path(folder)/'preview.db',artifact())
            try:
                self.assertEqual(p.process(payload(4),end=END,query=QUERY)['incidents'][0]['payload']['type'],'UNKNOWN_ANOMALY')
                with patch('resilience_alpha_ai.anomaly_detection.incident_pipeline.analyze_payload',return_value={'predictions':[{'is_anomaly':False}]}):
                    self.assertEqual(p.process(payload(),end=END,query=QUERY)['incidents'],[])
            finally:p.close()
    def test_prototype_and_threshold_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            for a in (artifact(),{**artifact(True),'threshold_status':'provisional_not_validated'}):
                with self.assertRaises(ValueError):IncidentPipeline(Path(folder)/'live.db',a,mode='deliver',client=object())
            self.assertFalse((Path(folder)/'live.db').exists())
    def test_preview_database_cannot_be_delivered(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'preview.db';p=IncidentPipeline(path,artifact());p.close()
            with self.assertRaises(ValueError):IncidentPipeline(path,artifact(True),mode='deliver',client=object())
    def test_malformed_snapshot_does_not_queue(self):
        with tempfile.TemporaryDirectory() as folder:
            p=IncidentPipeline(Path(folder)/'preview.db',artifact())
            try:
                data=payload();data['data']['result'][0]['values'].append(['900','invalid-json'])
                with self.assertRaises(ValueError):p.process(data,end=END,query=QUERY)
                self.assertEqual(p.outbox.ready(),[])
            finally:p.close()
    def test_full_flow_outage_restart_delivery_and_no_duplicate(self):
        sent=[]
        def handler(request):
            if request.url.path=='/v1/token':return httpx.Response(200,json=dict(access_token='test',token_type='Bearer',expires_in=900))
            sent.append(json.loads(request.content));return httpx.Response(202,json={'id':'incident-test'})
        def outage(request):raise httpx.ConnectError('offline',request=request)
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'live.db'
            with httpx.Client(transport=httpx.MockTransport(outage)) as http:
                p=IncidentPipeline(path,artifact(True),mode='deliver',client=RemediationClient(http,'http://auth.test','http://rem.test','detector','test'))
                try:
                    first=p.process(payload(),end=END,query=QUERY)['incidents'][0]['payload']
                    self.assertEqual(p.flush(now=100)['deferred'],1)
                finally:p.close()
            with httpx.Client(transport=httpx.MockTransport(handler)) as http:
                p=IncidentPipeline(path,artifact(True),mode='deliver',client=RemediationClient(http,'http://auth.test','http://rem.test','detector','test'))
                try:
                    self.assertEqual(p.flush(now=104)['accepted'],0)
                    self.assertEqual(p.flush(now=105)['accepted'],1)
                    self.assertFalse(p.process(payload(),end=END,query=QUERY)['incidents'][0]['queued'])
                    self.assertEqual(p.flush(now=106)['accepted'],0)
                    self.assertEqual(sent,[first])
                finally:p.close()
    def test_forbidden_stops_with_incident_pending(self):
        def forbidden(request):
            if request.url.path=='/v1/token':return httpx.Response(200,json=dict(access_token='test',token_type='Bearer',expires_in=900))
            return httpx.Response(403)
        with tempfile.TemporaryDirectory() as folder,httpx.Client(transport=httpx.MockTransport(forbidden)) as http:
            p=IncidentPipeline(Path(folder)/'live.db',artifact(True),mode='deliver',client=RemediationClient(http,'http://auth.test','http://rem.test','detector','test'))
            try:
                p.process(payload(),end=END,query=QUERY)
                with self.assertRaisesRegex(RuntimeError,'403'):p.flush(now=100)
                self.assertEqual(len(p.outbox.ready(now=100)),1)
            finally:p.close()

if __name__=='__main__':unittest.main()
