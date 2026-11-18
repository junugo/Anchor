import assert from 'node:assert/strict'
import test from 'node:test'
import { hashPassword, verifyPassword } from './password'

test('password：哈希可校验、错误密码 false', async () => {
  const { hash } = await hashPassword('correct horse battery staple')
  assert.equal(await verifyPassword('correct horse battery staple', hash), true)
  assert.equal(await verifyPassword('wrong password', hash), false)
})

test('password：两次哈希盐不同，存储串可自描述解析', async () => {
  const a = await hashPassword('same-password')
  const b = await hashPassword('same-password')
  assert.notEqual(a.hash, b.hash)
  const parts = a.hash.split('$')
  assert.equal(parts.length, 6)
  assert.equal(parts[0], 'scrypt')
  assert.equal(parts[1], '16384')
  assert.equal(parts[2], '8')
  assert.equal(parts[3], '1')
})

test('password：params 为可解析的 JSON，含 N/r/p', async () => {
  const { params } = await hashPassword('x')
  const parsed = JSON.parse(params)
  assert.deepEqual(parsed, { n: 16384, r: 8, p: 1 })
})

test('password：格式非法一律 false，不抛', async () => {
  assert.equal(await verifyPassword('x', ''), false)
  assert.equal(await verifyPassword('x', 'not-a-hash'), false)
  assert.equal(await verifyPassword('x', 'scrypt$16384$8'), false)
  assert.equal(await verifyPassword('x', 'bcrypt$16384$8$1$aa$bb'), false)
  assert.equal(await verifyPassword('x', 'scrypt$abc$8$1$aa$bb'), false)
  assert.equal(await verifyPassword('x', 'scrypt$16384$8$1$zz-not-hex$bb'), false)
  assert.equal(await verifyPassword('x', 'scrypt$999999999$8$1$aa$bb'), false) // N 越界 → scrypt 抛错 → false
})

test('password：空密码与超长密码可往返', async () => {
  const { hash } = await hashPassword('')
  assert.equal(await verifyPassword('', hash), true)
  const long = await hashPassword('a'.repeat(1000))
  assert.equal(await verifyPassword('a'.repeat(1000), long.hash), true)
})
