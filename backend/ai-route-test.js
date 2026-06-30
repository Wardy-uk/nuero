const aiRouting = require('./services/ai-routing');
(async () => {
  const result = await aiRouting.runTask('knowledge_consolidation', {
    prompt: 'Return only this JSON: {"summary":"ok","durableInsights":[],"openLoops":[],"promotionCandidates":[],"suggestedLinks":[],"filingNote":"ok"}',
    maxTokens: 120,
    temperature: 0.1
  }, { timeout: 90000 });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
