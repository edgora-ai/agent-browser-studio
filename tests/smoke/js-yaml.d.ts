// Narrow local declaration for the single API consumed by multiplatform-ci.
// js-yaml 4.x exports default.load in dist/js-yaml.mjs; load returns arbitrary
// YAML values (including null/undefined/scalars), not a workflow object.
declare module 'js-yaml' {
  export function load(input: string): unknown;
  const yaml: { load: typeof load };
  export default yaml;
}
