// vitest setup — enable React's act(...) environment under jsdom so state updates in
// render tests are flushed deterministically and without the act() warning.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
