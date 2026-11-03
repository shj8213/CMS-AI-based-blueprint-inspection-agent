"""실제 에이전트를 호출하지 않는 비교 도구 검사예요."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from tools.omission_evaluation import evaluate, prepare


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "kit"
        prepare(self.root)
        private = self.root / "evaluator-only"
        self.answers = json.loads((private / "answers.json").read_text(encoding="utf-8"))
        self.results = json.loads((private / "results.json").read_text(encoding="utf-8"))
        self.answers["human_approved"] = True
        self.results.update(mode="mock", agent_version="도구 단위 검사", run_date="모의 실행",
                            human_reviewed=True)

    def report(self):
        return evaluate(self.answers, self.results, self.root / "agent-input")

    def record(self, case, response, findings):
        self.results["cases"][case] = {
            "state": "completed", "response": response, "findings": findings,
        }

    def test_blind_package(self):
        public = self.root / "agent-input"
        self.assertEqual({p.name for p in public.iterdir()}, {"D017.pdf", "D042.pdf", "request.txt"})
        self.assertTrue((public / "D017.pdf").read_bytes().startswith(b"%PDF-1.4"))
        self.assertIn(b"MATERIAL: ALUMINUM", (public / "D042.pdf").read_bytes())
        self.assertNotIn("material", (public / "request.txt").read_text(encoding="utf-8").lower())
        draft = json.loads((self.root / "evaluator-only" / "answers.json").read_text(encoding="utf-8"))
        self.assertIs(draft["human_approved"], False)
        self.assertEqual(len(draft["cases"]["D017"]["omissions"]), 1)
        self.assertEqual(draft["cases"]["D042"]["omissions"], [])

    def test_pdf_object_offsets_and_stream_length(self):
        for case in ("D017", "D042"):
            pdf = (self.root / "agent-input" / f"{case}.pdf").read_bytes()
            xref_offset = int(pdf.split(b"startxref\n")[1].splitlines()[0])
            self.assertTrue(pdf[xref_offset:].startswith(b"xref\n"))
            entries = pdf[xref_offset:].splitlines()[3:8]
            for index, entry in enumerate(entries, 1):
                offset = int(entry.split()[0])
                self.assertTrue(pdf[offset:].startswith(f"{index} 0 obj\n".encode()))
            stream_header, remaining = pdf.split(b"\nstream\n")
            length = int(stream_header.rsplit(b"/Length ", 1)[1].split()[0])
            self.assertEqual(remaining[length:length + 10], b"\nendstream")

    def test_not_run_is_not_zero_score(self):
        text = self.report()
        self.assertIn("| D017 | 미실행 | — | — | — | — |", text)
        self.assertIn("실제 성능이 아니에요", text)

    def test_found_and_false_positive(self):
        self.record("D017", "재질 칸이 비어 있음", [{
            "quote": "재질 칸이 비어 있음", "decision": "match",
            "omission_id": "material", "reason": "위치와 의미가 정답과 같음",
        }])
        self.record("D042", "폭 누락", [{
            "quote": "폭 누락", "decision": "false_positive", "reason": "25가 기재되어 있음",
        }])
        text = self.report()
        self.assertIn("| D017 | 사람 대조 완료 | 재질 칸이 비어 있음 | 없음 | 없음 | 없음 |", text)
        self.assertIn("| D042 | 사람 대조 완료 | 없음 | 없음 | 폭 누락 | 없음 |", text)

    def test_missed_and_normal(self):
        for case in self.results["cases"]:
            self.record(case, "이상 없음", [])
        text = self.report()
        self.assertIn("| D017 | 사람 대조 완료 | 없음 | 재질 칸이 비어 있음 | 없음 | 없음 |", text)
        self.assertIn("| D042 | 사람 대조 완료 | 없음 | 없음 | 없음 | 없음 |", text)

    def test_uncertainty_is_pending(self):
        self.record("D017", "재질 판독 확인 필요", [{
            "quote": "재질 판독 확인 필요", "decision": "pending", "reason": "누락으로 확정하지 않음",
        }])
        text = self.report()
        self.assertIn("확정하지 않음(판단 보류 있음)", text)
        self.assertNotIn("| D017 | 사람 대조 완료", text)

    def test_truth_and_response_require_human_checks(self):
        for key, data in (("human_approved", self.answers), ("human_reviewed", self.results)):
            data[key] = False
            with self.assertRaises(ValueError):
                self.report()
            data[key] = True

    def test_modified_drawing_rejected(self):
        (self.root / "agent-input" / "D017.pdf").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            self.report()

    def test_missing_case_rejected(self):
        del self.results["cases"]["D042"]
        with self.assertRaises(ValueError):
            self.report()

    def test_invalid_findings_rejected(self):
        valid = {"quote": "재질 누락", "decision": "match", "omission_id": "material", "reason": "대조"}
        invalid = [
            dict(valid, quote="원문에 없는 말"),
            dict(valid, omission_id="unknown"),
            dict(valid, decision="guess"),
            dict(valid, reason=""),
        ]
        for finding in invalid:
            with self.subTest(finding=finding):
                self.record("D017", "재질 누락", [finding])
                with self.assertRaises(ValueError):
                    self.report()
        self.record("D017", "재질 누락. 재질이 없음.", [valid, dict(valid, quote="재질이 없음")])
        with self.assertRaises(ValueError):
            self.report()

    def test_empty_and_unrun_with_results_rejected(self):
        self.record("D017", "", [])
        with self.assertRaises(ValueError):
            self.report()
        self.results["cases"]["D017"]["state"] = "not_run"
        self.results["cases"]["D017"]["response"] = "결과"
        with self.assertRaises(ValueError):
            self.report()

    def test_no_overwriting(self):
        with self.assertRaises(ValueError):
            prepare(self.root)

    def test_report_does_not_render_raw_html(self):
        self.record("D017", "<script>alert(1)</script>|내용", [])
        self.assertIn("&lt;script&gt;", self.report())
        self.assertNotIn("<script>", self.report())

    def test_cli_errors_and_answer_leak_protection(self):
        private = self.root / "evaluator-only"
        for name, value in (("answers.json", self.answers), ("results.json", self.results)):
            (private / name).write_text(json.dumps(value), encoding="utf-8")
        command = [sys.executable, "-m", "tools.omission_evaluation", "report", str(self.root)]
        blocked = subprocess.run(command + [str(self.root / "agent-input" / "report.md")],
                                 capture_output=True)
        self.assertNotEqual(blocked.returncode, 0)
        output = self.root / "report.md"
        success = subprocess.run(command + [str(output)], capture_output=True)
        self.assertEqual(success.returncode, 0, success.stderr)
        before = output.read_bytes()
        duplicate = subprocess.run(command + [str(output)], capture_output=True)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertEqual(before, output.read_bytes())


if __name__ == "__main__":
    unittest.main()
