# Android Performance Benchmarks by Device Tier

## RAM Thresholds

| Tier | Total RAM | Available Target | Warning Level |
|------|-----------|-----------------|---------------|
| Low-end (Go) | 1-2 GB | > 400 MB | < 200 MB |
| Budget | 2-3 GB | > 600 MB | < 300 MB |
| Mid-range | 4-6 GB | > 1.5 GB | < 800 MB |
| High-end | 8-12 GB | > 3 GB | < 1.5 GB |
| Flagship | 12-16 GB | > 5 GB | < 2.5 GB |

## Background Process Recommendations

| RAM | Max Background Procs | Rationale |
|-----|---------------------|-----------|
| 1-2 GB | 1 | Aggressive, essential apps only |
| 2-3 GB | 2 | Budget, limit heavy services |
| 4-6 GB | 3-4 | Standard, most apps work fine |
| 8+ GB | Default (-1) | No restriction needed |

## Battery Temperature

| Temp (C) | Status |
|----------|--------|
| < 30 | Normal |
| 30-38 | Warm (normal under load) |
| 38-42 | Hot (reduce usage) |
| > 42 | Critical (stop charging, close apps) |

## Storage Health

| Free Space % | Status |
|-------------|--------|
| > 20% | Healthy |
| 10-20% | Monitor |
| 5-10% | Clean up needed |
| < 5% | Critical (system instability) |

## POCO Serenity Baselines (2.7GB RAM, Unisoc T615)

Baseline after bloatware cleanup (2026-04-01):

| Metric | Value | Status |
|--------|-------|--------|
| RAM Available | ~1.3 GB | OK for budget |
| Storage Free | 38 GB / 50 GB | Healthy |
| Background Procs | ~35 | High (4 user profiles) |
| Battery Temp | 24.8 C | Normal |
| Security Patch | 2025-09-01 | 6 months old |
