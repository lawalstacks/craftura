import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getAdminSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const admin = await getAdminSession()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const type   = searchParams.get('type') || 'orders'    // orders | inquiries | products
  const format = searchParams.get('format') || 'csv'     // csv | xlsx
  const from   = searchParams.get('from')                // YYYY-MM-DD
  const to     = searchParams.get('to')                  // YYYY-MM-DD

  const dateFilter = from || to ? {
    createdAt: {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to   ? { lte: new Date(to + 'T23:59:59') } : {}),
    },
  } : {}

  try {
    let rows: Record<string, string | number | null>[] = []
    let filename = ''

    if (type === 'orders') {
      const orders = await prisma.order.findMany({
        where: dateFilter,
        include: {
          items: {
            include: { product: { select: { name: true, price: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
      })

      filename = `craftura-orders-${dateLabel(from, to)}`
      rows = orders.map(order => ({
        'Order Number':   order.orderNumber,
        'Date':           formatDate(order.createdAt),
        'Customer Name':  order.customerName,
        'Email':          order.email,
        'Phone':          order.phone,
        'Address':        order.address,
        'Order Type':     order.orderType,
        'Status':         order.status,
        'Items':          order.items.map(i => `${i.product.name} ×${i.quantity}`).join(' | '),
        'Est. Value (₹)': order.items.reduce((sum, i) => sum + (i.product.price || 0) * i.quantity, 0) || '',
        'Notes':          order.notes || '',
        'Created At':     formatDate(order.createdAt),
        'Updated At':     formatDate(order.updatedAt),
      }))

    } else if (type === 'inquiries') {
      const inquiries = await prisma.inquiry.findMany({
        where: dateFilter,
        orderBy: { createdAt: 'desc' },
      })

      filename = `craftura-inquiries-${dateLabel(from, to)}`
      rows = inquiries.map(inq => ({
        'Date':       formatDate(inq.createdAt),
        'Name':       inq.name,
        'Email':      inq.email,
        'Phone':      inq.phone,
        'Subject':    inq.subject || '',
        'Message':    inq.message,
        'Status':     inq.isRead ? 'Read' : 'Unread',
      }))

    } else if (type === 'products') {
      const products = await prisma.product.findMany({
        include: {
          category: { select: { name: true } },
          _count:   { select: { orderItems: true } },
        },
        orderBy: { createdAt: 'desc' },
      })

      filename = `craftura-products-${dateLabel(from, to)}`
      rows = products.map(p => ({
        'Name':        p.name,
        'Category':    p.category.name,
        'Material':    p.material || '',
        'Dimensions':  p.dimensions || '',
        'Price (₹)':   p.price || '',
        'MOQ':         p.moq || '',
        'Featured':    p.featured ? 'Yes' : 'No',
        'In Stock':    p.inStock ? 'Yes' : 'No',
        'Total Orders': p._count.orderItems,
        'Created At':  formatDate(p.createdAt),
      }))
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No data found for the selected filters.' }, { status: 404 })
    }

    if (format === 'xlsx') {
      const xlsx = buildXlsx(rows, type)
      return new NextResponse(new Uint8Array(xlsx), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
        },
      })
    }

    // Default: CSV
    const csv = buildCsv(rows)
    return new NextResponse(csv, {
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      },
    })

  } catch (err) {
    console.error('[Export]', err)
    return NextResponse.json({ error: 'Export failed.' }, { status: 500 })
  }
}

// ── CSV builder ───────────────────────────────────────────────
function buildCsv(rows: Record<string, string | number | null>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const escape  = (val: string | number | null) => {
    const s = String(val ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const lines = [
    headers.map(escape).join(','),
    ...rows.map(row => headers.map(h => escape(row[h])).join(',')),
  ]
  return '\uFEFF' + lines.join('\r\n') // BOM for Excel UTF-8 support
}

// ── XLSX builder (pure XML/OOXML — no library needed) ─────────
function buildXlsx(rows: Record<string, string | number | null>[], sheetName: string): Buffer {
  if (rows.length === 0) return Buffer.from('')

  const headers  = Object.keys(rows[0])
  const colCount = headers.length
  const rowCount = rows.length + 1 // +1 for header

  // Convert column index to Excel letter (A, B, ... Z, AA, AB...)
  const colLetter = (n: number): string => {
    let s = ''
    n++
    while (n > 0) {
      const rem = (n - 1) % 26
      s = String.fromCharCode(65 + rem) + s
      n = Math.floor((n - 1) / 26)
    }
    return s
  }

  // Shared strings table
  const strings: string[] = []
  const strIndex: Record<string, number> = {}
  const addStr = (s: string): number => {
    if (strIndex[s] === undefined) {
      strIndex[s] = strings.length
      strings.push(s)
    }
    return strIndex[s]
  }

  // Build cell refs
  const sheetRows: string[] = []

  // Header row
  const headerCells = headers.map((h, ci) => {
    const si = addStr(h)
    return `<c r="${colLetter(ci)}1" t="s"><v>${si}</v></c>`
  }).join('')
  sheetRows.push(`<row r="1">${headerCells}</row>`)

  // Data rows
  rows.forEach((row, ri) => {
    const rowNum = ri + 2
    const cells  = headers.map((h, ci) => {
      const val = row[h]
      const ref = `${colLetter(ci)}${rowNum}`
      if (val === null || val === '') return `<c r="${ref}"/>`
      if (typeof val === 'number') return `<c r="${ref}"><v>${val}</v></c>`
      const si = addStr(String(val))
      return `<c r="${ref}" t="s"><v>${si}</v></c>`
    }).join('')
    sheetRows.push(`<row r="${rowNum}">${cells}</row>`)
  })

  // Column widths
  const colWidths = headers.map((h, i) => {
    const maxLen = Math.max(
      h.length,
      ...rows.map(r => String(r[h] ?? '').length)
    )
    return `<col min="${i+1}" max="${i+1}" width="${Math.min(maxLen + 2, 50)}" bestFit="1" customWidth="1"/>`
  }).join('')

  // XML parts
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetFormatPr defaultRowHeight="15"/>
<cols>${colWidths}</cols>
<sheetData>${sheetRows.join('')}</sheetData>
<sheetView showGridLines="1" tabSelected="1" workbookViewId="0">
  <selection activeCell="A1" sqref="A1"/>
</sheetView>
</worksheet>`

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('')}
</sst>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`

  const appRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`

  // Pack into ZIP (XLSX is a ZIP file)
  return packZip([
    { name: '[Content_Types].xml',         data: contentTypes },
    { name: '_rels/.rels',                 data: appRels },
    { name: 'xl/workbook.xml',             data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels',  data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml',    data: sheetXml },
    { name: 'xl/sharedStrings.xml',        data: sharedStringsXml },
  ])
}

// ── Minimal ZIP packer (no external library) ──────────────────
function packZip(files: { name: string; data: string }[]): Buffer {
  const encoder = new TextEncoder()
  const entries: { name: Uint8Array; data: Uint8Array; offset: number }[] = []
  const parts: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const dataBytes = encoder.encode(file.data)
    const crc       = crc32(dataBytes)
    const localHdr  = localFileHeader(nameBytes, dataBytes, crc)

    entries.push({ name: nameBytes, data: dataBytes, offset })
    parts.push(localHdr, dataBytes)
    offset += localHdr.length + dataBytes.length
  }

  const cdParts: Uint8Array[] = []
  let cdSize = 0
  const cdOffset = offset

  for (const entry of entries) {
    const cd = centralDirHeader(entry.name, entry.data, crc32(entry.data), entry.offset)
    cdParts.push(cd)
    cdSize += cd.length
  }

  const eocd = endOfCentralDirectory(entries.length, cdSize, cdOffset)
  const all  = [...parts, ...cdParts, eocd]
  const total = all.reduce((s, b) => s + b.length, 0)
  const out   = new Uint8Array(total)
  let pos = 0
  for (const b of all) { out.set(b, pos); pos += b.length }
  return Buffer.from(out)
}

function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0))
  let p = 0; for (const a of arrays) { out.set(a, p); p += a.length }
  return out
}

function localFileHeader(name: Uint8Array, data: Uint8Array, crc: number): Uint8Array {
  return concat(
    new Uint8Array([0x50,0x4B,0x03,0x04]), u16(20), u16(0), u16(0), u16(0), u16(0),
    u32(crc), u32(data.length), u32(data.length),
    u16(name.length), u16(0), name
  )
}

function centralDirHeader(name: Uint8Array, data: Uint8Array, crc: number, offset: number): Uint8Array {
  return concat(
    new Uint8Array([0x50,0x4B,0x01,0x02]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
    u32(crc), u32(data.length), u32(data.length),
    u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
  )
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Uint8Array {
  return concat(
    new Uint8Array([0x50,0x4B,0x05,0x06]),
    u16(0), u16(0), u16(count), u16(count),
    u32(cdSize), u32(cdOffset), u16(0)
  )
}

function crc32(data: Uint8Array): number {
  const table = crc32Table()
  let crc = 0xFFFFFFFF
  for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xFF]
  return (crc ^ 0xFFFFFFFF) >>> 0
}

let _crcTable: number[] | null = null
function crc32Table(): number[] {
  if (_crcTable) return _crcTable
  _crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    return c
  })
  return _crcTable
}

// ── Helpers ───────────────────────────────────────────────────
function escapeXml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function dateLabel(from?: string | null, to?: string | null): string {
  if (from && to) return `${from}_to_${to}`
  if (from)       return `from_${from}`
  if (to)         return `to_${to}`
  return new Date().toISOString().slice(0, 7)
}
