import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, scan } from '../lib/radar.js';

test('competition and opportunity sources stay in distinct global research lanes', () => {
  const competitionIds = new Set(SOURCES.filter((source) => source.group === 'competition').map((source) => source.id));
  const opportunityIds = new Set(SOURCES.filter((source) => source.group !== 'competition').map((source) => source.id));

  for (const id of ['kaggle', 'devpost', 'amazon-science', 'geo-environment-challenges']) assert.ok(competitionIds.has(id), id);
  for (const id of ['phd-research', 'faculty-roles', 'grants', 'geospatial']) assert.ok(opportunityIds.has(id), id);
  assert.equal(competitionIds.has('phd-research'), false);
  assert.equal(opportunityIds.has('devpost'), false);
});

test('radar rejects unsupported categories before searching external sources', async () => {
  await assert.rejects(scan({ category: 'trading' }), /unknown radar category/);
});
