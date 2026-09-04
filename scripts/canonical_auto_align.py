#!/usr/bin/env python3
"""Align active backend documentation/public copy to the HustleXP canonical authority set.

This script changes repository text only. It authorizes no deployment, provider action,
payment, or production effect.
"""
from __future__ import annotations

from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {'.ts', '.tsx', '.js', '.md', '.html', '.json', '.yml', '.yaml', '.sql'}
SKIP_PARTS = {'.git', 'node_modules', 'dist', 'coverage', '.cache'}

AUTHORITY = """# HustleXP Canonical Authority

Status: CURRENT DOCUMENTATION POINTER / NOT PRODUCTION AUTHORITY
Effective date: 2026-09-03
Production effect: NONE

## Current authority set

1. HustleXP Business and Universal V1 Charter v1.3.0.
2. Payment Infrastructure Pre-Integration Underwriting Package v3.4.
3. Universal Intake, WorkLinks, and Learning Rail v1.0.
4. Universal V1 Frontend and WorkLink Specification v1.1.
5. Activation, Notification, and Lifecycle Copy Specification v2.0.
6. Canonical Project Context v1.3.0.
7. /OPS Internal Operations Control Plane Specification v1.1.
8. Canonical Document Index v1.0.
9. Exact source, PostgreSQL, CI, deployment, runtime, processor, legal, and reconciled outcome evidence for current-state claims.

Google Drive current folder: https://drive.google.com/drive/folders/1UcfNHVspKHGglv6FiyqVd0_4SvUke5kv

## Backend invariants

- One immutable transaction root and PostgreSQL-owned final lifecycle authority.
- MARKETPLACE, PROVIDER_OS, and BRING_YOUR_OWN_PROVIDER are the only relationship origins.
- WorkLinks, Task Opportunities, and recurrence do not create parallel lifecycles.
- Interest is not assignment. Payment-method readiness is not financial security. Capture is not funding. Funding is not reconciliation.
- Direct-provider payment uses a separate ExternalPaymentOutcome and never fabricates platform payment states.
- Production customer-money creation remains frozen until exact external gates pass.
- AI has no independent authority over price, eligibility, money, assignment, private-data release, restrictions, closure, or production enablement.
- DESIGNED, IMPLEMENTED, TESTED, DEPLOYED, ENABLED, USED, PROVEN, and PRODUCTION_HEALTHY are separate claims.

This pointer does not supersede native Google Docs or exact implementation/runtime evidence.
"""

CURRENT_REPLACEMENTS = {
    'HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.1': 'HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.4',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.1': 'Payment Infrastructure Pre-Integration Underwriting Package v3.4',
    'HustleXP Business and Universal V1 Charter v1.2.0': 'HustleXP Business and Universal V1 Charter v1.3.0',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.3': 'Payment Infrastructure Pre-Integration Underwriting Package v3.4',
    'Canonical Project Context v1.2.0': 'Canonical Project Context v1.3.0',
    '/OPS Internal Operations Control Plane Specification v1.0': '/OPS Internal Operations Control Plane Specification v1.1',
    'hello@hustlexp.app': 'support@hustlexp.app',
}

CURRENT_DOCS = {
    'docs/HUSTLEXP_TEAM_ALIGNMENT.md',
    'docs/source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md',
    'docs/source-contracts/README.md',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
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
    'Business and Universal V1 Charter v1.2.0',
    'Payment Infrastructure Pre-Integration Underwriting Package v3.3',
    'Canonical Project Context v1.2.0',
    '/OPS Internal Operations Control Plane Specification v1.0',
}


def text_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in TEXT_SUFFIXES and not any(part in SKIP_PARTS for part in path.parts)


def prepend_once(path: Path, marker: str, banner: str) -> None:
    text = path.read_text(encoding='utf-8')
    if marker not in text[:1500]:
        path.write_text(banner + text, encoding='utf-8')


def classify_history() -> None:
    for rel in HISTORICAL_DOCS:
        path = ROOT / rel
        if path.exists():
            prepend_once(
                path,
                'Status: HISTORICAL / NOT CURRENT AUTHORITY',
                '# HISTORICAL SOURCE RECORD — NOT CURRENT AUTHORITY\n\n'
                'Status: HISTORICAL / NOT CURRENT AUTHORITY\n'
                'Current authority: Charter v1.3.0, Underwriting v3.4, Learning Rail v1.0, Frontend and WorkLink v1.1, Activation/Copy v2.0, Context v1.3.0, and /OPS v1.1.\n'
                'Production effect: NONE\n\n',
            )


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
        'Treatment: every unrefreshed current-state claim is UNKNOWN. This file grants no merge, deployment, provider, payment, or production authority.\n\n',
    )


def patch_current_docs() -> None:
    for rel in CURRENT_DOCS:
        path = ROOT / rel
        if not path.exists():
            continue
        text = path.read_text(encoding='utf-8')
        for old, new in CURRENT_REPLACEMENTS.items():
            text = text.replace(old, new)
        if rel == 'docs/source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md':
            text = text.replace('**Version:** 1.0', '**Version:** 1.1')
            text = text.replace('Status: PROPOSED TARGET STATE — NOT REPRESENTED AS BUILT', 'Status: CURRENT PROPOSED TARGET STATE — NOT REPRESENTED AS BUILT')
            text = text.replace(
                '**Controlling business model:** Local-services marketplace + Provider OS + task-opportunity acquisition + recurring work',
                '**Controlling business model:** Managed local-work transaction network with MARKETPLACE, PROVIDER_OS, and BRING_YOUR_OWN_PROVIDER origins; WorkLinks, Task Opportunities, recurring occurrences, general services, and regulated trades share one lifecycle',
            )
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


def explicit_history(path: Path, text: str) -> bool:
    rel = str(path.relative_to(ROOT)).lower()
    head = text[:1500].lower()
    return (
        '/archive/' in f'/{rel}'
        or 'historical' in Path(rel).name
        or re.search(r'20\d{2}-\d{2}-\d{2}', Path(rel).name) is not None
        or 'status: historical' in head
        or 'historical source record' in head
        or 'frozen evidence' in head
    )


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
        if old_refs or public_hits:
            violations.append({'path': rel, 'obsolete_refs': old_refs, 'prohibited_public': public_hits})
    return violations


def main() -> int:
    classify_history()
    mark_checkpoint_stale()
    patch_current_docs()
    patch_public_terms()
    write_authority()
    violations = verify()
    report = {
        'authority_set': 'Charter v1.3.0 / Underwriting v3.4 / Learning Rail v1.0 / Frontend+WorkLink v1.1 / Activation+Copy v2.0 / Context v1.3.0 / OPS v1.1',
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
