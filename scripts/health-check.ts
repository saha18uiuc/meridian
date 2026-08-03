#!/usr/bin/env tsx
import { main } from '@meridian/ops/health-check';
await main(process.argv.slice(2));
