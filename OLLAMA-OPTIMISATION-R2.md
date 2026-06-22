# Ollama Optimisation — Round 2

## Context
You already audited the Pi 5 Ollama setup. Current best: qwen2.5:1.5b at 12 tok/s.
We want to squeeze more speed out of this hardware for a voice assistant use case.
Target: sub-3-second responses for short answers.

## Task 1: Clean up unused models
Remove gemma3:1b and smollm2:1.7b. Keep qwen2.5:1.5b and qwen2.5:3b.

## Task 2: Try alternative small models
Pull and benchmark these against qwen2.5:1.5b using the same 100-token warm test:

- `gemma2:2b`
- `phi3.5:latest` (if available, try the smallest quant)
- `qwen3:1.7b` (or whatever the smallest qwen3 is on Ollama)

If any of these don't exist on Ollama, skip them and note it. Don't waste time hunting.

Same benchmark method as before: warm the model first, then time a 100-token conversational response. Record tok/s and subjective quality.

## Task 3: Tuning the current best model
Try each of these independently on qwen2.5:1.5b (or whatever wins Task 2) and measure the impact:

1. **Context length** — check current setting. Try reducing to 2048 if it's higher. Measure tok/s difference.
2. **Quantisation** — try Q4_0 instead of Q4_K_M if available. Measure tok/s vs quality tradeoff.
3. **Thread count** — check OLLAMA_NUM_THREADS. Pi 5 has 4 cores. Try 4 explicitly if not set.
4. **mlock** — verify the model is locked in RAM. If not, enable it.

## Task 4: System prompt audit
Check the NEURO backend's chat endpoint to see how many tokens the system prompt is.
- Read `backend/services/claude.js` or wherever the system prompt is assembled
- Count approximate token length of the full system prompt + context injection
- Report the number — if it's over 1000 tokens, flag it as a latency contributor

## Task 5: Final recommendation
After all tests, give me:
- Best model + quant combination
- Optimal Ollama config settings
- System prompt size and whether it needs trimming
- Realistic tok/s achievable
- Honest assessment: is this fast enough for voice, or do we need a different approach?

## Important
- Don't change the NEURO backend code — read only for the system prompt audit
- Do change Ollama config if you find improvements
- Set the winner as the running model when done
- Before/after comparison table at the end
