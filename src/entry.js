// Legacy compatibility shim.
// Historical entry-v1.x wrappers still import ./entry.js.
// New code should import named modules or the stable src/error-bus.js entrypoint.
export { default } from './core-registry.js';
