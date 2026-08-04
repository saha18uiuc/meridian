#!/usr/bin/env tsx
import { main } from '@meridian/ops/terminate-running-workflows';
await main(process.argv.slice(2));
