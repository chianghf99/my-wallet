#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""trigger_bill_reminder.py 的回歸測試（不碰網路、不碰真實 Keychain）。"""

import io
import json
import sys
import unittest
import urllib.error
from email.message import Message
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trigger_bill_reminder as tbr


class FakeResponse:
    def __init__(self, status=204):
        self.status = status

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestTriggerBillReminder(unittest.TestCase):

    def test_trigger_bill_reminder_dispatches_correct_workflow(self):
        captured = {}

        def fake_opener(req, timeout=20):
            captured['url'] = req.full_url
            captured['method'] = req.get_method()
            captured['auth'] = req.get_header('Authorization')
            captured['body'] = json.loads(req.data.decode('utf-8'))
            return FakeResponse(204)

        ok, detail = tbr.trigger_bill_reminder('ghp_test_token', opener=fake_opener)
        self.assertTrue(ok)
        self.assertEqual(detail, 'HTTP 204')
        self.assertEqual(captured['method'], 'POST')
        self.assertTrue(captured['url'].endswith('/actions/workflows/bill-reminder.yml/dispatches'))
        self.assertEqual(captured['auth'], 'Bearer ghp_test_token')
        self.assertEqual(captured['body'], {'ref': 'main'})

    def test_trigger_bill_reminder_401_does_not_leak_pat(self):
        secret_pat = 'github_pat_SUPER_SECRET_REMINDER'

        def fake_opener(req, timeout=20):
            raise urllib.error.HTTPError(
                req.full_url, 401, 'Unauthorized', Message(), io.BytesIO(b'{}'))

        ok, detail = tbr.trigger_bill_reminder(secret_pat, opener=fake_opener)
        self.assertFalse(ok)
        self.assertIn('401', detail)
        self.assertNotIn(secret_pat, detail)

    def test_powershell_task_script_defaults_to_0830_with_wake_flags(self):
        ps = tbr.build_powershell_task_script(
            r'C:\Python313\python.exe',
            r'C:\dev\my-wallet\scripts\trigger_bill_reminder.py',
        )
        self.assertIn('-WakeToRun', ps)
        self.assertIn('-StartWhenAvailable', ps)
        self.assertIn('-AllowStartIfOnBatteries', ps)
        self.assertIn('08:30', ps)
        self.assertIn(tbr.TASK_NAME, ps)


if __name__ == '__main__':
    unittest.main()
