#!/usr/bin/env python3
"""Read a small public Parquet split and emit JSON records on stdout."""

import json
import sys

try:
    import pyarrow.parquet as parquet
except ModuleNotFoundError as exc:  # pragma: no cover - environment dependent
    print("读取 Parquet 需要 Python 包 pyarrow：python3 -m pip install pyarrow", file=sys.stderr)
    raise SystemExit(2) from exc

if len(sys.argv) != 2:
    print("usage: read-parquet.py FILE", file=sys.stderr)
    raise SystemExit(2)

table = parquet.read_table(sys.argv[1])
print(json.dumps(table.to_pylist(), ensure_ascii=False))
