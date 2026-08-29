import { NextRequest } from 'next/server'
import jwt from 'jsonwebtoken'

export interface AuthUser {
  userId: string
  email: string
  role: string
}

// JWT 密钥：优先取环境变量，未配置时用随机兜底（仅用于本地开发）
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? (() => {
        throw new Error('JWT_SECRET 未配置，生产环境必须设置环境变量 JWT_SECRET')
      })()
    : 'dev-only-secret-do-not-use-in-production')

const JWT_EXPIRES_IN = '30d'

/**
 * 签发带签名的 JWT token（HS256，30 天过期）
 */
export function signAuthToken(user: { userId: string; email: string; role: string }): string {
  return jwt.sign(
    {
      userId: user.userId,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )
}

/**
 * 验证 JWT token，返回用户信息；无效或过期返回 null
 */
export function verifyAuthToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload
    if (!payload || !payload.userId || !payload.email) return null
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      role: (payload.role as string) || 'USER',
    }
  } catch {
    return null
  }
}

/**
 * 从请求的 Authorization 头中提取并验证用户
 * 返回用户信息，未提供/无效 token 时返回 null
 */
export function getAuthUser(request: NextRequest): AuthUser | null {
  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return verifyAuthToken(authHeader.substring(7))
}
