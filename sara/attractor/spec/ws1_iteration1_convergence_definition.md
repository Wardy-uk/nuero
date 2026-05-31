# WS1 Iteration 1 Convergence Definition — Location And Confidence Completion

## Work Package

`WS1-WP1-ITER1`

## Observable Success Criteria

This iteration is converged when behavioural evaluation confirms that:

1. current location is exposed consistently in the governed runtime
2. current confidence is exposed consistently in the governed runtime
3. the frontend runtime surface displays both values
4. both values are honestly labelled if still seeded or derived
5. previously passing WS1 behaviour remains passing

## Failure Conditions

- either location or confidence is still absent
- frontend and backend surfaces disagree about either field
- honest invalid-model behaviour regresses
- the iteration expands into broader WS2-style dashboard work

## Manager Decision Rule

- Pass: WS1 converged
- Iterate: a bounded WS1 follow-up is still required
- Blocked: the State Engine contract still does not satisfy its required fields
