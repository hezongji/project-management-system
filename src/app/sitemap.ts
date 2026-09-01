import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const now = new Date()

  const routes = [
    { path: '/', priority: 0.9, changeFrequency: 'daily' as const },
    { path: '/projects', priority: 0.8, changeFrequency: 'daily' as const },
    { path: '/tasks', priority: 0.8, changeFrequency: 'daily' as const },
    { path: '/login', priority: 0.5, changeFrequency: 'monthly' as const },
    { path: '/register', priority: 0.5, changeFrequency: 'monthly' as const },
    { path: '/docs', priority: 0.7, changeFrequency: 'weekly' as const },
    ...['project', 'tasks', 'purchase', 'expense', 'drive', 'im', 'android', 'mcp', 'quickstart', 'deployment', 'faq'].map(
      (slug) => ({
        path: `/docs/${slug}`,
        priority: 0.6,
        changeFrequency: 'monthly' as const,
      }),
    ),
  ]

  return routes.map((route) => ({
    url: `${baseUrl}${route.path}`,
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }))
}
