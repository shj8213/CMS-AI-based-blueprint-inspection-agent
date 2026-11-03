"""도면만 전달하는 시험 꾸러미와 사람이 대조하는 평가표를 만들어요."""

import argparse
import hashlib
import html
import json
from pathlib import Path


CASES = ("D017", "D042")


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def make_pdf(material):
    """직접 제작한 단일 페이지 부품도예요. 외부 자료는 사용하지 않아요."""
    drawing = [
        "0.8 w 80 160 280 100 re S",
        "80 140 m 360 140 l S 80 135 m 80 145 l S 360 135 m 360 145 l S",
        "60 160 m 60 260 l S 55 160 m 65 160 l S 55 260 m 65 260 l S",
        "60 320 400 80 re S 60 360 m 460 360 l S",
        "BT /F1 14 Tf 80 375 Td (TRAINING PART - NOT FOR MANUFACTURE) Tj ET",
        "BT /F1 12 Tf 80 340 Td (PART: RECTANGULAR PLATE   UNITS: mm) Tj ET",
        f"BT /F1 12 Tf 80 300 Td (MATERIAL: {material}) Tj ET",
        "BT /F1 12 Tf 200 122 Td (70) Tj ET",
        "BT /F1 12 Tf 30 205 Td (25) Tj ET",
        "BT /F1 12 Tf 80 80 Td (THICKNESS: 5 mm) Tj ET",
    ]
    content = "\n".join(drawing).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 520 440] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n"
        + content + b"\nendstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{start}\n%%EOF\n".encode()
    )
    return bytes(pdf)


def prepare(destination):
    if destination.exists():
        raise ValueError("저장 폴더가 이미 있어요. 새 경로를 지정해 주세요.")
    public = destination / "agent-input"
    private = destination / "evaluator-only"
    public.mkdir(parents=True)
    private.mkdir()
    drawings = {}
    for case, material in zip(CASES, ("", "ALUMINUM")):
        pdf = make_pdf(material)
        (public / f"{case}.pdf").write_bytes(pdf)
        drawings[case] = {
            "sha256": hashlib.sha256(pdf).hexdigest(),
            "omissions": ([{
                "id": "material",
                "description": "재질 칸이 비어 있음",
                "location": "1페이지·상단 MATERIAL 칸",
                "reason": "재질을 지정하는 칸은 있지만 값이 적혀 있지 않아요.",
            }] if case == "D017" else []),
        }
    (public / "request.txt").write_text(
        "첨부한 도면을 확인하고, 빠졌다고 판단한 정보와 그 위치·이유를 설명해 주세요."
        "읽지 못하거나 판단하기 어려운 부분은 ‘확인 필요’로 구분해 주세요.\n",
        encoding="utf-8",
    )
    save_json(private / "answers.json", {
        "human_approved": False,
        "scope": "기재 항목 누락을 확인하는 단순 연습도예요. 제조용 도면·규격 적합의 정답은 아니에요.",
        "cases": drawings,
    })
    save_json(private / "results.json", {
        "mode": "actual",
        "agent_version": "",
        "run_date": "",
        "human_reviewed": False,
        "cases": {case: {"state": "not_run", "response": "", "findings": []} for case in CASES},
    })


def required(condition, message):
    if not condition:
        raise ValueError(message)


def cell(value):
    return html.escape(str(value)).replace("|", "\\|").replace("\r", " ").replace("\n", "<br>")


def evaluate(answers, results, public):
    required(answers.get("human_approved") is True, "먼저 사람이 도면과 정답을 확인해 주세요.")
    required(results.get("human_reviewed") is True, "먼저 사람이 응답과 항목 대응을 확인해 주세요.")
    required(results.get("mode") in ("actual", "mock"), "mode는 actual 또는 mock이어야 해요.")
    required(bool(results.get("agent_version")) and bool(results.get("run_date")),
             "실행일과 에이전트 버전을 기록해 주세요.")
    cases = answers["cases"]
    required(set(cases) == set(results["cases"]), "정답과 결과의 도면 목록이 달라요.")
    lines = [
        "# 도면 누락 탐지 시험 기록",
        "",
        "**모의 결과로 도구를 시험한 기록이며 실제 성능이 아니에요.**" if results["mode"] == "mock"
        else "**사람이 입력한 실제 에이전트 응답의 비교 기록이에요. 응답의 진위는 사람이 확인해요.**",
        "",
        f"버전: {cell(results['agent_version'])} / 실행일: {cell(results['run_date'])}",
        "",
        "| 도면 | 상태 | 찾은 누락 | 놓친 누락 | 잘못 지적한 항목 | 판단 보류 |",
        "|---|---|---|---|---|---|",
    ]
    details = []
    for case, truth in cases.items():
        required(case in CASES, "알 수 없는 도면 식별자예요.")
        pdf = (public / f"{case}.pdf").read_bytes()
        required(hashlib.sha256(pdf).hexdigest() == truth["sha256"],
                 f"{case}: 정답 확인 대상 도면과 파일이 달라요.")
        omissions = truth["omissions"]
        ids = [item["id"] for item in omissions]
        required(len(set(ids)) == len(ids), f"{case}: 정답 식별자가 중복됐어요.")
        record = results["cases"][case]
        required(record.get("state") in ("not_run", "completed"), f"{case}: 실행 상태가 올바르지 않아요.")
        if record["state"] == "not_run":
            required(not record.get("response") and not record.get("findings"),
                     f"{case}: 미실행 상태에 결과가 들어 있어요.")
            lines.append(f"| {case} | 미실행 | — | — | — | — |")
            continue
        response = record.get("response")
        required(isinstance(response, str) and bool(response.strip()), f"{case}: 응답 원문이 필요해요.")
        required(isinstance(record.get("findings"), list), f"{case}: findings는 목록이어야 해요.")
        found, false_positives, pending = set(), [], []
        seen_quotes = set()
        details.extend(["", f"## {case}", "", "### 응답 원문", ""])
        details.extend("> " + cell(line) for line in response.splitlines())
        details.extend(["", "### 사람의 대응 판단", ""])
        for finding in record["findings"]:
            quote = finding.get("quote")
            required(isinstance(quote, str) and bool(quote.strip()) and quote in response,
                     f"{case}: 지적한 항목의 인용이 응답 원문에 없어요.")
            required(quote not in seen_quotes, f"{case}: 같은 인용이 중복됐어요.")
            seen_quotes.add(quote)
            decision = finding.get("decision")
            required(decision in ("match", "false_positive", "pending"), f"{case}: 판단 값이 올바르지 않아요.")
            required(bool(finding.get("reason")), f"{case}: 사람이 판단한 이유가 필요해요.")
            if decision == "match":
                target = finding.get("omission_id")
                required(target in ids, f"{case}: 대응하는 정답이 없어요.")
                required(target not in found, f"{case}: 같은 누락을 두 번 셌어요.")
                found.add(target)
            elif decision == "false_positive":
                false_positives.append(quote)
            else:
                pending.append(quote)
            labels = {"match": "찾은 누락", "false_positive": "잘못 지적한 항목", "pending": "판단 보류"}
            details.append(f"- {labels[decision]}: {cell(quote)} — {cell(finding['reason'])}")
        missed = [item["description"] for item in omissions if item["id"] not in found]
        status = "잠정·판단 보류 있음" if pending else "사람 대조 완료"
        missed_text = "확정하지 않음(판단 보류 있음)" if pending else "; ".join(missed) or "없음"
        found_text = "; ".join(item["description"] for item in omissions if item["id"] in found) or "없음"
        lines.append(
            f"| {case} | {status} | {cell(found_text)} | {cell(missed_text)} | "
            f"{cell('; '.join(false_positives) or '없음')} | {cell('; '.join(pending) or '없음')} |"
        )
    return "\n".join(lines + details) + "\n"


def main():
    parser = argparse.ArgumentParser(description="도면 누락 탐지 시험 준비와 대조")
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("prepare")
    setup.add_argument("destination", type=Path)
    score = commands.add_parser("report")
    score.add_argument("directory", type=Path)
    score.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare(args.destination)
        else:
            private = args.directory / "evaluator-only"
            required(not args.output.resolve().is_relative_to((args.directory / "agent-input").resolve()),
                     "정답이 포함된 보고서는 agent-input 밖에 저장해 주세요.")
            answers = json.loads((private / "answers.json").read_text(encoding="utf-8"))
            results = json.loads((private / "results.json").read_text(encoding="utf-8"))
            report = evaluate(answers, results, args.directory / "agent-input")
            with args.output.open("x", encoding="utf-8") as output:
                output.write(report)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f"시험 준비·대조 실패: {error}\n")


if __name__ == "__main__":
    main()
