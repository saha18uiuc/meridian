#!/usr/bin/env tsx
import { main as boards } from '@meridian/ops/fixtures/boards';
import { main as coiBoard } from '@meridian/ops/fixtures/coi-board';
import { main as coiDocuments } from '@meridian/ops/fixtures/coi-documents';
import { main as coiEvalCases } from '@meridian/ops/fixtures/coi-eval-cases';
import { main as documents } from '@meridian/ops/fixtures/documents';
import { main as evalCases } from '@meridian/ops/fixtures/eval-cases';
import { main as specSnapshot } from '@meridian/ops/fixtures/spec-snapshot';

// Order matters: the boards feed the spec snapshot, and the documents feed the eval cases.
await boards();
await coiBoard();
await documents();
await evalCases();
await coiDocuments();
await coiEvalCases();
await specSnapshot();
