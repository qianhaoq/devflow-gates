#!/usr/bin/env python3
"""Reject workflow_run listeners that include their own workflow name."""
from pathlib import Path
import sys
import yaml


def self_listens(text):
    workflow = yaml.safe_load(text) or {}
    triggers = workflow.get('on', workflow.get(True, {})) or {}
    listener = triggers.get('workflow_run', {}) if isinstance(triggers, dict) else {}
    names = listener.get('workflows', []) if isinstance(listener, dict) else []
    if isinstance(names, str):
        names = [names]
    return bool(workflow.get('name') and workflow['name'] in names)


def main():
    files = [p for folder in ('examples', '.github/workflows') for p in Path(folder).glob('*.yml')]
    bad = [str(p) for p in files if self_listens(p.read_text())]
    if bad:
        print('workflow cannot listen to itself: ' + ', '.join(bad), file=sys.stderr)
        return 1
    print(f'No self-listening workflows ({len(files)} checked)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
