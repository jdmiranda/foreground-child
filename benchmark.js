#!/usr/bin/env node

/**
 * Benchmark suite for foreground-child optimizations
 * Tests process spawn overhead, signal propagation, and stdio throughput
 */

import { foregroundChild } from './dist/esm/index.js'
import { spawn } from 'child_process'
import { performance } from 'perf_hooks'

const ITERATIONS = {
  spawn: 100,
  signal: 50,
  stdio: 20,
}

// Utility functions
const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length
const median = arr => {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const min = arr => Math.min(...arr)
const max = arr => Math.max(...arr)

console.log('=== foreground-child Performance Benchmark ===\n')

// Benchmark 1: Process spawn overhead
async function benchmarkSpawnOverhead() {
  console.log(`[1/3] Process Spawn Overhead (${ITERATIONS.spawn} iterations)`)
  const times = []

  for (let i = 0; i < ITERATIONS.spawn; i++) {
    const start = performance.now()
    await new Promise((resolve, reject) => {
      const child = foregroundChild('node', ['-e', 'process.exit(0)'], err => {
        if (err && err !== 0) reject(err)
      })
      child.on('close', resolve)
      child.on('error', reject)
    })
    const duration = performance.now() - start
    times.push(duration)
  }

  console.log(`  Average:  ${avg(times).toFixed(2)}ms`)
  console.log(`  Median:   ${median(times).toFixed(2)}ms`)
  console.log(`  Min:      ${min(times).toFixed(2)}ms`)
  console.log(`  Max:      ${max(times).toFixed(2)}ms`)
  console.log()
}

// Benchmark 2: Signal propagation speed
async function benchmarkSignalPropagation() {
  console.log(
    `[2/3] Signal Propagation Speed (${ITERATIONS.signal} iterations)`,
  )
  const times = []

  for (let i = 0; i < ITERATIONS.signal; i++) {
    const start = performance.now()
    await new Promise((resolve, reject) => {
      const child = foregroundChild(
        'node',
        [
          '-e',
          `
        let count = 0;
        setInterval(() => {
          count++;
          if (count > 3) process.exit(0);
        }, 10);
      `,
        ],
        err => {
          if (err && err !== 0) reject(err)
        },
      )

      // Send signal after a short delay
      setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch (e) {
          // Process may have already exited
        }
      }, 50)

      child.on('close', () => {
        const duration = performance.now() - start
        times.push(duration)
        resolve()
      })
      child.on('error', reject)
    })
  }

  console.log(`  Average:  ${avg(times).toFixed(2)}ms`)
  console.log(`  Median:   ${median(times).toFixed(2)}ms`)
  console.log(`  Min:      ${min(times).toFixed(2)}ms`)
  console.log(`  Max:      ${max(times).toFixed(2)}ms`)
  console.log()
}

// Benchmark 3: stdio throughput
async function benchmarkStdioThroughput() {
  console.log(`[3/3] stdio Throughput (${ITERATIONS.stdio} iterations)`)
  const times = []
  const dataSize = 1024 * 10 // 10KB

  for (let i = 0; i < ITERATIONS.stdio; i++) {
    const testData = 'x'.repeat(dataSize)
    const start = performance.now()

    await new Promise((resolve, reject) => {
      const child = foregroundChild(
        'node',
        ['-e', `process.stdin.pipe(process.stdout)`],
        err => {
          if (err && err !== 0) reject(err)
        },
      )

      let received = ''
      if (child.stdout) {
        child.stdout.on('data', chunk => {
          received += chunk.toString()
          if (received.length >= dataSize) {
            child.kill()
          }
        })
      }

      if (child.stdin) {
        child.stdin.write(testData)
        child.stdin.end()
      }

      child.on('close', () => {
        const duration = performance.now() - start
        times.push(duration)
        resolve()
      })
      child.on('error', reject)
    })
  }

  const throughputMBps = times.map(t => (dataSize / 1024 / 1024 / t) * 1000)

  console.log(`  Average Time:        ${avg(times).toFixed(2)}ms`)
  console.log(`  Median Time:         ${median(times).toFixed(2)}ms`)
  console.log(`  Average Throughput:  ${avg(throughputMBps).toFixed(2)} MB/s`)
  console.log(`  Min Throughput:      ${min(throughputMBps).toFixed(2)} MB/s`)
  console.log(`  Max Throughput:      ${max(throughputMBps).toFixed(2)} MB/s`)
  console.log()
}

// Run all benchmarks
async function runBenchmarks() {
  try {
    await benchmarkSpawnOverhead()
    await benchmarkSignalPropagation()
    await benchmarkStdioThroughput()

    console.log('=== Benchmark Complete ===')
    console.log('\nOptimizations applied:')
    console.log('  ✓ Cached signal list computation')
    console.log('  ✓ Optimized signal listener setup with typed Map')
    console.log('  ✓ Pre-configured stdio arrays (fast path)')
    console.log('  ✓ Reduced closure allocations')
    console.log('  ✓ Reused default cleanup function')
    console.log('  ✓ Optimized watchdog spawn options')
  } catch (error) {
    console.error('Benchmark failed:', error)
    process.exit(1)
  }
}

runBenchmarks()
