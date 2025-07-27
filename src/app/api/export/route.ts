import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') || 'json'
    const type = searchParams.get('type') || 'sensors'
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const device = searchParams.get('device')

    const where: any = {}
    
    if (device) {
      where.device = device
    }
    
    if (startDate || endDate) {
      where.timestamp = {}
      if (startDate) {
        where.timestamp.gte = new Date(startDate)
      }
      if (endDate) {
        where.timestamp.lte = new Date(endDate)
      }
    }

    let data: any[]
    let filename: string

    if (type === 'sensors') {
      data = await prisma.sensorData.findMany({
        where,
        orderBy: { timestamp: 'desc' }
      })
      filename = `sensor-data-${new Date().toISOString().split('T')[0]}`
    } else if (type === 'events') {
      const events = await prisma.event.findMany({
        where,
        orderBy: { timestamp: 'desc' }
      })
      // Convert BigInt duration to string for export
      data = events.map(event => ({
        ...event,
        duration: event.duration.toString()
      }))
      filename = `events-${new Date().toISOString().split('T')[0]}`
    } else {
      return NextResponse.json(
        { error: 'Invalid export type' },
        { status: 400 }
      )
    }

    if (format === 'csv') {
      const csv = convertToCSV(data)
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${filename}.csv"`
        }
      })
    } else {
      return new NextResponse(JSON.stringify(data, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}.json"`
        }
      })
    }

  } catch (error) {
    console.error('Error exporting data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

function convertToCSV(data: any[]): string {
  if (data.length === 0) return ''
  
  const headers = Object.keys(data[0])
  const csvHeaders = headers.join(',')
  
  const csvRows = data.map(row => 
    headers.map(header => {
      const value = row[header]
      if (value instanceof Date) {
        return value.toISOString()
      }
      if (typeof value === 'string' && value.includes(',')) {
        return `"${value}"`
      }
      return value
    }).join(',')
  )
  
  return [csvHeaders, ...csvRows].join('\n')
}