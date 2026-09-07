#!/usr/bin/env python3
"""Align active backend documentation/public copy to the HustleXP authority set.

This script changes repository text only. It authorizes no deployment, provider action,
payment, assignment, certification, or production effect. It is intentionally idempotent.
"""
from __future__ import annotations

from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {'.ts', '.tsx', '.js', '.md', '.html', '.json', '.yml', '.yaml', '.sql'}
SKIP_PARTS = {'.git', 'node_modules', 'dist', 'coverage', '.cache'}

CANONICAL_INDEX_ID = '1QTrT40LK5zo-DN6ER7naM3p43WlyxkBxKsjL23p20mY'
CURRENT_UNDERWRITING_ID = '1lbxM2D4vPX3NfzEPa6JvnvdS3EWzfL48aNY8piTBrYg'
ARCHIVED_UNDERWRITING_IDS = {
    '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
    '1D15PhGW9gh5lTypYuQEkb4IH1G3MJUpVRmR1aZkRqrg',
}

INDEX_URL = f'https://docs.google.com/document/d/{CANONICAL_INDEX_ID}/edit'
UNDERWRITING_URL = f'https://docs.google.com/document/d/{CURRENT_UNDERWRITING_ID}/edit'
CURRENT_FOLDER_URL = 'https://drive.google.com/drive/folders/1UcfNHVspKHGglv6FiyqVd0_4SvUke5kv'
POINTER_MARKER = 'Canonical authority pointer:'
POINTER_BANNER = (
    '> **Canonical authority pointer:** `docs/canonical/HUSTLEXP_CANONICAL_AUTHORITY.md` '
    f'and [HustleXP Canonical Document Index v1.0]({INDEX_URL}).\n'
    '> **Production effect:** NONE. Current implementation, deployment, payment, provider, '
    'and outcome claims require source-dated exact evidence.\n\n'
)

AUTHORITY = f"""# HustleXP Canonical Authority

Status: CURRENT DOCUMENTATION POINTER / NOT PRODUCTION AUTHORITY
Effective date: 2026-09-03
Last pointer verification: 2026-09-04 UTC
Production effect: NONE

## Current authority set

1. HustleXP Business and Universal V1 Charter v1.3.0 — controlling business and product-policy authority.
2. [Payment Infrastructure Pre-Integration Underwriting Package v3.4]({UNDERWRITING_URL}) — current subordinate payment-design authority; not processor approval.
3. Universal Intake, WorkLinks, and Learning Rail v1.0 — current execution-priority authority.
4. Universal V1 Frontend and WorkLink Specification v1.1 — current proposed participant-experience target.
5. Activation, Notification, and Lifecycle Copy Specification v2.0 — current lifecycle, copy, consent, and notification target.
6. Canonical Project Context v1.3.0 — current orientation.
7. /OPS Internal Operations Control Plane Specification v1.1 — current proposed internal-control target.
8. [Canonical Document Index v1.0]({INDEX_URL}) — Drive authority, retrieval, supersession, and quarantine register.
9. Exact source, PostgreSQL, CI, deployment, runtime, processor, legal, and reconciled outcome evidence — current implementation and operating truth.

Google Drive current folder: {CURRENT_FOLDER_URL}

## Backend invariants

- One immutable transaction root and PostgreSQL-owned final lifecycle authority.
- MARKETPLACE, PROVIDER_OS, and BRING_YOUR_OWN_PROVIDER are the only relationship origins.
- WorkLinks, Task Opportunities, and recurrence do not create parallel lifecycles.
- Interest is not assignment. Payment-method readiness is not financial security. Capture is not funding. Funding is not reconciliation.
- Direct-provider payment uses a separate ExternalPaymentOutcome and never fabricates platform payment states.
- Production customer-money creation remains frozen until every named external, certification, review, and release gate passes.
- AI has no independent authority over price, eligibility, money, assignment, private-data release, restrictions, closure, or production enablement.
- DESIGNED, IMPLEMENTED, TESTED, DEPLOYED, ENABLED, USED, PROVEN, and PRODUCTION_HEALTHY are separate claims.

This repository file is a pointer. It does not supersede the native Google Docs or exact implementation/runtime evidence.
"""

CURRENT_REPLACEMENTS = {
    'HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.1': 'HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.4',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.1': 'Payment Infrastructure Pre-Integration Underwriting Package v3.4',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.2': 'Payment Infrastructure Pre-Integration Underwriting Package v3.4',
    'HustleXP Business and Universal V1 Charter v1.2.0': 'HustleXP Business and Universal V1 Charter v1.3.0',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.3': 'Payment Infrastructure Pre-Integration Underwriting Package v3.4',
    'Canonical Project Context v1.2.0': 'Canonical Project Context v1.3.0',
    '/OPS Internal Operations Control Plane Specification v1.0': '/OPS Internal Operations Control Plane Specification v1.1',
    'hello@hustlexp.app': 'support@hustlexp.app',
}
for archived_id in ARCHIVED_UNDERWRITING_IDS:
    CURRENT_REPLACEMENTS[archived_id] = CURRENT_UNDERWRITING_ID

CURRENT_DOCS = {
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/HUSTLEXP_TEAM_ALIGNMENT.md',
    'docs/source-contracts/README.md',
    'docs/source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md',
}

HISTORICAL_DOCS = {
    'docs/architecture/HUSTLEXP_PAYMENT_OPS_CONVERGENCE_RECORD.md',
    'docs/source-contracts/HUSTLEXP_BACKEND_PR_AUDIT_AND_CONVERGENCE_MISSION.md',
}

PROHIBITED_PUBLIC = {
    'protected payment',
    'payment is released',
    'anything legal and physical-world',
    'claim job',
    'google verified',
    'google-verified',
    'fully vetted',
    'instant dispatch',
    'you earned $',
    'your hustler is on the way',
}

OBSOLETE_CURRENT_REFS = {
    'Payment Infrastructure Pre-Integration Underwriting Package v3.1',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.2',
    'Business and Universal V1 Charter v1.2.0',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.3',
    'Canonical Project Context v1.2.0',
    '/OPS Internal Operations Control Plane Specification v1.0',
    *ARCHIVED_UNDERWRITING_IDS,
}


def text_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in TEXT_SUFFIXES and not any(part in SKIP_PARTS for part in path.parts)


def prepend_once(path: Path, marker: str, banner: str) -> None:
    text = path.read_text(encoding='utf-8')
    if marker.lower() not in text[:2000].lower():
        path.write_text(banner + text, encoding='utf-8')


def explicit_history(path: Path, text: str) -> bool:
    rel = str(path.relative_to(ROOT)).lower()
    head = text[:1800].lower()
    return (
        '/archive/' in f'/{rel}'
        or 'historical' in Path(rel).name
        or re.search(r'20\d{2}-\d{2}-\d{2}', Path(rel).name) is not None
        or 'status: historical' in head
        or 'historical source record' in head
        or 'frozen evidence' in head
        or 'legacy_non_executable' in head
    )


def classify_history() -> None:
    banner = (
        '# HISTORICAL SOURCE RECORD — NOT CURRENT AUTHORITY\n\n'
        'Status: HISTORICAL / NOT CURRENT AUTHORITY\n'
        'Current authority: Charter v1.3.0, Underwriting v3.4, Learning Rail v1.0, '
        'Frontend and WorkLink v1.1, Activation/Copy v2.0, Context v1.3.0, and /OPS v1.1.\n'
        f'Canonical authority pointer: {INDEX_URL}\n'
        'Production effect: NONE\n\n'
    )
    for rel in HISTORICAL_DOCS:
        path = ROOT / rel
        if path.exists():
            prepend_once(path, 'Status: HISTORICAL / NOT CURRENT AUTHORITY', banner)


def mark_checkpoint_stale() -> None:
    path = ROOT / 'docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md'
    if not path.exists():
        return
    prepend_once(
        path,
        'Status: STALE_CURRENT_STATE_INVENTORY',
        '# STALE CURRENT-STATE INVENTORY — REVERIFY BEFORE USE\n\n'
        'Status: STALE_CURRENT_STATE_INVENTORY / SOURCE_DATED / NOT_PRODUCTION_AUTHORITY\n'
        'Stale as of: 2026-09-03 because the recorded source, deployment, configuration, migration, and evidence identities predate the current repository state.\n'
        'Treatment: every unrefreshed current-state claim is UNKNOWN. This file grants no merge, deployment, provider, payment, or production authority.\n'
        f'Canonical authority pointer: {INDEX_URL}\n\n',
    )


def patch_team_alignment(text: str) -> str:
    text = re.sub(
        r'Last evidence refresh: `[^`]+`',
        'Last target-document authority refresh: `2026-09-04 UTC`',
        text,
        count=1,
    )
    text = re.sub(
        r'- `HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3\.4`, \[Google Doc\]\([^)]+\), tab `t\.0`, revision `[^`]+`, modified `[^`]+`;',
        f'- [HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.4]({UNDERWRITING_URL}), current subordinate payment-design authority effective `2026-09-03`; record a fresh Docs revision and observed-at timestamp before any source-exact claim;',
        text,
        count=1,
    )
    text = re.sub(
        r'- the byte-preserved \[Backend PR Audit, Architecture Convergence, and Processor-Readiness Mission\]\([^)]+\), SHA-256 `[^`]+`;',
        '- the explicitly historical [Backend PR Audit, Architecture Convergence, and Processor-Readiness Mission](source-contracts/HUSTLEXP_BACKEND_PR_AUDIT_AND_CONVERGENCE_MISSION.md), retained only as source-dated evidence and not as current authority;',
        text,
        count=1,
    )
    text = re.sub(
        r'- the byte-preserved \[`/OPS` Internal Operations Control Plane Specification\]\([^)]+\), SHA-256 `[^`]+`;',
        '- the current proposed [`/OPS` Internal Operations Control Plane Specification v1.1](source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md); bind any source-exact claim to the reviewed blob SHA rather than a mutable filename;',
        text,
        count=1,
    )
    return text


def patch_current_docs() -> None:
    for rel in CURRENT_DOCS:
        path = ROOT / rel
        if not path.exists():
            continue
        text = path.read_text(encoding='utf-8')
        for old, new in CURRENT_REPLACEMENTS.items():
            text = text.replace(old, new)
        if rel == 'docs/HUSTLEXP_TEAM_ALIGNMENT.md':
            text = patch_team_alignment(text)
        if rel == 'docs/source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md':
            text = text.replace('**Version:** 1.0', '**Version:** 1.1')
            text = text.replace(
                '**Status:** PROPOSED TARGET STATE — NOT REPRESENTED AS BUILT',
                '**Status:** CURRENT_TEAM_TARGET / PROPOSED_NOT_BUILT / NOT_PRODUCTION_AUTHORITY',
            )
            text = text.replace(
                '**Controlling business model:** Local-services marketplace + Provider OS + task-opportunity acquisition + recurring work',
                '**Controlling business model:** Managed local-work transaction network with MARKETPLACE, PROVIDER_OS, and BRING_YOUR_OWN_PROVIDER origins; WorkLinks, Task Opportunities, recurring occurrences, general services, and regulated trades share one lifecycle',
            )
        if POINTER_MARKER.lower() not in text[:2000].lower():
            text = POINTER_BANNER + text
        path.write_text(text, encoding='utf-8')


def patch_public_terms() -> None:
    path = ROOT / 'public/terms-of-service.html'
    if not path.exists():
        return
    text = path.read_text(encoding='utf-8')
    replacements = {
        "<li>The Task Poster's payment is authorized and held securely</li>":
            '<li>Any platform payment action is available only when the approved processor capability and task-specific gates permit it.</li>',
        '<li>Upon successful completion and confirmation, the payment is released to the Hustler</li>':
            '<li>Completion, customer notice, incident, and amount gates determine the next recorded financial state. Capture, funding, payout, and reconciliation remain separate.</li>',
        '<li>If a task is canceled before completion, the payment is refunded to the Task Poster (minus any applicable fees)</li>':
            '<li>Cancellation follows the disclosed policy and actual transaction state. The applicable action may be no processor action, a reversal, void, refund, or external-provider outcome.</li>',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = text.replace('hello@hustlexp.app', 'support@hustlexp.app')
    path.write_text(text, encoding='utf-8')


def write_authority() -> None:
    path = ROOT / 'docs/canonical/HUSTLEXP_CANONICAL_AUTHORITY.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(AUTHORITY, encoding='utf-8')


def verify() -> list[dict[str, object]]:
    violations: list[dict[str, object]] = []
    for path in ROOT.rglob('*'):
        if not text_file(path):
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        if explicit_history(path, text):
            continue
        rel = str(path.relative_to(ROOT))
        old_refs = sorted(ref for ref in OBSOLETE_CURRENT_REFS if ref in text)
        public_hits: list[str] = []
        if rel.startswith('public/'):
            lower = text.lower()
            public_hits = sorted(term for term in PROHIBITED_PUBLIC if term in lower)
        missing_pointer = rel in CURRENT_DOCS and POINTER_MARKER.lower() not in text[:2000].lower()
        if old_refs or public_hits or missing_pointer:
            violations.append({
                'path': rel,
                'obsolete_refs_or_archived_ids': old_refs,
                'prohibited_public': public_hits,
                'missing_current_authority_pointer': missing_pointer,
            })
    return violations


def main() -> int:
    classify_history()
    mark_checkpoint_stale()
    patch_current_docs()
    patch_public_terms()
    write_authority()
    violations = verify()
    report = {
        'authority_set': 'Charter v1.3.0 / Underwriting v3.4 / Learning Rail v1.0 / Frontend+WorkLink v1.1 / Activation+Copy v2.0 / Context v1.3.0 / OPS v1.1 / Index v1.0',
        'canonical_index_id': CANONICAL_INDEX_ID,
        'current_underwriting_id': CURRENT_UNDERWRITING_ID,
        'production_effect': 'NONE',
        'violations': violations,
        'result': 'PASS' if not violations else 'FAIL',
    }
    report_path = ROOT / 'docs/canonical/CANONICAL_ALIGNMENT_REPORT.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if not violations else 1


if __name__ == '__main__':
    raise SystemExit(main())
