import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import WhatsAppFloat from '@/components/layout/WhatsAppFloat'
import { prisma } from '@/lib/prisma'

// Default — all tabs visible if no DB record exists yet
const NAV_DEFAULTS: Record<string, string> = {
  nav_show_gallery:     'true',
  nav_show_bulk_orders: 'true',
  nav_show_blog:        'true',
  nav_show_about:       'true',
  nav_show_contact:     'true',
}

async function getNavSettings(): Promise<Record<string, boolean>> {
  const keys = Object.keys(NAV_DEFAULTS)
  const records = await prisma.siteContent.findMany({
    where: { key: { in: keys } },
  })

  const result: Record<string, boolean> = {}
  for (const key of keys) {
    const record = records.find(r => r.key === key)
    // If no record exists yet, use the default (true = visible)
    result[key] = record ? record.value === 'true' : true
  }
  return result
}

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const navSettings = await getNavSettings() as Record<string, boolean> & {
    nav_show_gallery: boolean;
    nav_show_bulk_orders: boolean;
    nav_show_blog: boolean;
    nav_show_about: boolean;
    nav_show_contact: boolean;
  }

  return (
    <>
      <Navbar navSettings={navSettings} />
      <main className="min-h-screen">{children}</main>
      <Footer navSettings={navSettings} />
      <WhatsAppFloat />
    </>
  )
}
