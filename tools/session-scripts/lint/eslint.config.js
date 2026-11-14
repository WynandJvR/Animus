// The gate's no-undef pass: an undeclared name (a renamed variable, a helper's local used outside it) throws only when its
// branch runs - node --check and xmodcheck cannot see it (holdBack in restRound, e.tod = t after the day refactor,
// 2026-09-29). Only this rule: style is not the gate's business.
const globals = require('./node_modules/globals')
module.exports = [{
  files: ['**/*.js'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
  rules: { 'no-undef': 'error' }
}]
