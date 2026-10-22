"""Regression coverage for startup output mixed with auth events."""
import json
from pathlib import Path
import tempfile
import unittest
from test_incident_pipeline import artifact, payload, END, QUERY
from resilience_alpha_ai.anomaly_detection.loki_parser import parse_loki_response
from resilience_alpha_ai.anomaly_detection.incident_pipeline import IncidentPipeline

STARTUP = ['', 'No pending migrations to apply.', '3 migrations found in prisma/migrations',
 'Datasource "db": PostgreSQL database "auth", schema "public" at "db-auth:5432"',
 'Prisma schema loaded from prisma/schema.prisma.', 'Loaded Prisma config from prisma.config.ts.']

def mixed(lines):
    value = payload(8)
    value['data']['result'][0]['values'].extend([str(2000+i), line] for i,line in enumerate(lines))
    return value

class StartupLogsTests(unittest.TestCase):
    def test_plain_and_wrapped_startup_preserve_authentication(self):
        lines = STARTUP + [json.dumps({'log': s+'\n'}) for s in STARTUP]
        result = parse_loki_response(mixed(lines))
        self.assertEqual(len(result['events']), 8)
        self.assertEqual(result['ignored'], len(lines))
        self.assertEqual(result['rejected'], [])

    def test_unknown_text_and_damaged_authentication_still_rejected(self):
        lines = ['invalid-json', '{"event":"login_failed",',
                 'No pending migrations to apply. login_failed',
                 '{"service":"auth","event":"login_failed"}', json.dumps({'log':'broken'})]
        self.assertEqual(len(parse_loki_response(mixed(lines))['rejected']), len(lines))

    def test_incident_evidence_and_dedup_with_startup(self):
        with tempfile.TemporaryDirectory() as folder:
            pipeline = IncidentPipeline(Path(folder)/'queue.db', artifact())
            try:
                first = pipeline.process(mixed(STARTUP), end=END, query=QUERY)
                incident = first['incidents'][0]['payload']
                self.assertEqual(incident['stats']['failures'], 8)
                self.assertEqual(incident['evidence'][0]['value'], 8)
                self.assertEqual(incident['type'], 'BRUTE_FORCE')
                again = pipeline.process(mixed(STARTUP), end=END, query=QUERY)
                self.assertFalse(again['incidents'][0]['queued'])
                self.assertFalse(pipeline.flush()['enabled'])
            finally: pipeline.close()

    def test_invalid_authentication_prevents_queueing(self):
        with tempfile.TemporaryDirectory() as folder:
            pipeline = IncidentPipeline(Path(folder)/'queue.db', artifact())
            try:
                with self.assertRaisesRegex(ValueError, 'Malformed logs'):
                    pipeline.process(mixed(['{"service":"auth","event":"login_failed"}']), end=END, query=QUERY)
                self.assertEqual(pipeline.outbox.ready(), [])
            finally: pipeline.close()
