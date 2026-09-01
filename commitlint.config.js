module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 允许中文 subject（默认配置已放行非 ASCII），这里明确 type/scope 白名单
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
  },
}
