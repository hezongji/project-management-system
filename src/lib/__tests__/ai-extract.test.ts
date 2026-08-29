/**
 * AI JSON 抽取纯函数单测（★ 2026-08-22 生产加固批次）
 * extract.ts 是 MiMo 结构化输出的命门：模型偶发在 JSON 前后带说明/围栏/杂音。
 * 覆盖：整体 parse / 围栏剥离 / 平衡括号兜底 / 字符串内括号不误判 / 非法输入兜底。
 */

import { extractJsonObject, extractJsonArray } from '../ai/extract'

describe('extractJsonObject', () => {
  it('纯 JSON 对象：直接解析', () => {
    const r = extractJsonObject('{"title":"纪要","items":[1,2]}')
    expect(r).toEqual({ title: '纪要', items: [1, 2] })
  })

  it('```json 围栏包裹：剥围栏后解析', () => {
    const r = extractJsonObject('```json\n{"a":1,"b":"x"}\n```')
    expect(r).toEqual({ a: 1, b: 'x' })
  })

  it('前导说明文字 + 尾部杂音：定位首个平衡对象', () => {
    const r = extractJsonObject('好的，这是纪要结果：{"decision":"通过","due":"2026-08-30"} 以上就是全部。')
    expect(r).toEqual({ decision: '通过', due: '2026-08-30' })
  })

  it('对象前有 json 关键词：仍能抽取（indexOf { 兜底）', () => {
    const r = extractJsonObject('json {"x":1}')
    expect(r).toEqual({ x: 1 })
  })

  it('字符串内部含 { } 不误判为对象边界', () => {
    const r = extractJsonObject('前缀 {"a":"{not a boundary}","b":2} 尾部')
    expect(r).toEqual({ a: '{not a boundary}', b: 2 })
  })

  it('字符串内转义引号 \\" 不打断扫描', () => {
    const r = extractJsonObject('{"a":"say \\"hi\\"","b":3}')
    expect(r).toEqual({ a: 'say "hi"', b: 3 })
  })

  it('非法输入：无对象 → null', () => {
    expect(extractJsonObject('没有任何 JSON')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
  })

  it('不平衡括号（截断的 JSON）→ null，不抛异常', () => {
    expect(extractJsonObject('{"a":1,')).toBeNull()
  })

  it('数组整体输入 → null（object 语义不含数组）', () => {
    expect(extractJsonObject('[1,2,3]')).toBeNull()
  })
})

describe('extractJsonArray', () => {
  it('纯数组：直接解析', () => {
    const r = extractJsonArray('[1,2,3]')
    expect(r).toEqual([1, 2, 3])
  })

  it('围栏包裹数组', () => {
    const r = extractJsonArray('```json\n[{"name":"电机"},{"name":"电缆"}]\n```')
    expect(r).toEqual([{ name: '电机' }, { name: '电缆' }])
  })

  it('说明文字中抽取首个数组', () => {
    const r = extractJsonArray('解析结果如下：[10,20,30] 共 3 项')
    expect(r).toEqual([10, 20, 30])
  })

  it('无数组 → null', () => {
    expect(extractJsonArray('{"a":1}')).toBeNull()
    expect(extractJsonArray('nothing')).toBeNull()
  })

  it('对象输入 → null（array 语义不含对象）', () => {
    expect(extractJsonArray('{"a":1}')).toBeNull()
  })
})
