#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""trigger_snapshot.py 的回歸測試（不碰網路、不碰真實 Keychain）。"""

import io
import json
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trigger_snapshot as ts


class FakeResponse:
    def __init__(self, status=204):
        self.status = status

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestTriggerSnapshot(unittest.TestCase):

    def test_build_dispatch_payload_default(self):
        self.assertEqual(ts.build_dispatch_payload(), {'ref': 'main'})

    def test_build_dispatch_payload_with_target_date(self):
        self.assertEqual(
            ts.build_dispatch_payload(ref='main', target_date=' 2026-11-23 '),
            {'ref': 'main', 'inputs': {'target_date': '2026-11-23'}}
        )

    def test_trigger_workflow_success_204(self):
        captured = {}

        def fake_opener(req, timeout=20):
            captured['url'] = req.full_url
            captured['method'] = req.get_method()
            captured['auth'] = req.get_header('Authorization')
            captured['body'] = json.loads(req.data.decode('utf-8'))
            return FakeResponse(204)

        ok, detail = ts.trigger_workflow('ghp_secret_test_token', opener=fake_opener)
        self.assertTrue(ok)
        self.assertEqual(detail, 'HTTP 204')
        self.assertEqual(captured['method'], 'POST')
        self.assertTrue(captured['url'].endswith('/actions/workflows/daily-snapshot.yml/dispatches'))
        self.assertEqual(captured['auth'], 'Bearer ghp_secret_test_token')
        self.assertEqual(captured['body'], {'ref': 'main'})

    def test_trigger_workflow_401_does_not_leak_pat(self):
        secret_pat = 'github_pat_SUPER_SECRET_123456'

        def fake_opener(req, timeout=20):
            raise urllib.error.HTTPError(
                req.full_url, 401, 'Unauthorized', Message(), io.BytesIO(b'{"message":"Bad credentials"}'))

        ok, detail = ts.trigger_workflow(secret_pat, opener=fake_opener)
        self.assertFalse(ok)
        self.assertIn('401', detail)
        self.assertIn('過期', detail)
        self.assertNotIn(secret_pat, detail)

    def test_trigger_workflow_403_mentions_permissions(self):
        def fake_opener(req, timeout=20):
            raise urllib.error.HTTPError(
                req.full_url, 403, 'Forbidden', Message(), io.BytesIO(b''))

        ok, detail = ts.trigger_workflow('pat_123', opener=fake_opener)
        self.assertFalse(ok)
        self.assertIn('403', detail)
        self.assertIn('Actions', detail)

    def test_trigger_workflow_empty_pat(self):
        ok, detail = ts.trigger_workflow('   ')
        self.assertFalse(ok)
        self.assertIn('缺少 GitHub PAT', detail)

    def test_powershell_task_script_has_wake_and_missed_run_flags(self):
        ps = ts.build_powershell_task_script(r'C:\Python312\python.exe', r'C:\dev\my-wallet\scripts\trigger_snapshot.py', '14:35')
        self.assertIn('-WakeToRun', ps)
        self.assertIn('-StartWhenAvailable', ps)
        self.assertIn('-AllowStartIfOnBatteries', ps)
        self.assertIn('14:35', ps)
        self.assertIn(ts.TASK_NAME, ps)

    def test_get_telegram_creds_only_uses_iris_bot_token(self):
        orig = ts.keychain_get
        try:
            store = {
                (ts.KEYCHAIN_TG_SERVICE, 'chat_id'): '999',
                (ts.KEYCHAIN_TG_SERVICE, 'iris_bot_token'): 'tok_iris',
                (ts.KEYCHAIN_TG_SERVICE, 'bot_token'): 'tok_billbot',
            }
            ts.keychain_get = lambda s, a: store.get((s, a))
            tok, cid, acc = ts.get_telegram_creds()
            self.assertEqual((tok, cid, acc), ('tok_iris', '999', 'iris_bot_token'))

            # 移除 iris_bot_token 後不得退回帳單聊天室的 bot_token
            del store[(ts.KEYCHAIN_TG_SERVICE, 'iris_bot_token')]
            tok2, cid2, acc2 = ts.get_telegram_creds()
            self.assertEqual((tok2, cid2, acc2), (None, '999', None))
        finally:
            ts.keychain_get = orig


if __name__ == '__main__':
    unittest.main()
