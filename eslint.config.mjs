import coreWebVitals from 'eslint-config-next/core-web-vitals'

// eslint-config-next 16 原生 flat config；自定义规则需与插件定义在同一配置对象
const basePlugins = coreWebVitals[0].plugins

const eslintConfig = [
  ...coreWebVitals,
  {
    plugins: basePlugins,
    rules: {
      'react/no-unescaped-entities': 'off',
      '@next/next/no-page-custom-font': 'off',
      // 存量代码未治理，渐进收紧（原 .eslintrc.json 即为 warn）
      'react-hooks/exhaustive-deps': 'warn',
      'import/no-anonymous-default-export': 'off',
      'react/display-name': 'off',
      // react-hooks v6 新增规则（Next 16 升级引入），存量命中较多，先降级观察
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    files: ['**/*.stories.*'],
    rules: {
      'import/no-anonymous-default-export': 'off',
    },
  },
  {
    ignores: ['node_modules/**', '.next/**', '.next-standalone*/**', 'out/**', 'build/**', 'next-env.d.ts', 'uploads/**', 'coverage/**', 'scripts/**', '*.cjs'],
  },
]

export default eslintConfig
