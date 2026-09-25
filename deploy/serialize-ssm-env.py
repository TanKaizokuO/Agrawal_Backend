#!/usr/bin/env python3
"""Serialize AWS SSM JSON into a Docker Compose env_file stream."""

import json
import re
import sys


ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
COMPOSE_ESCAPES = {
    "\\": r"\\",
    '"': r'\"',
    "$": r"\$",
    "\a": r"\a",
    "\b": r"\b",
    "\f": r"\f",
    "\n": r"\n",
    "\r": r"\r",
    "\t": r"\t",
    "\v": r"\v",
}


def compose_value(value: str) -> str:
    escaped = []
    for char in value:
        if char == "\0":
            raise ValueError
        if char in COMPOSE_ESCAPES:
            escaped.append(COMPOSE_ESCAPES[char])
        elif ord(char) < 0x20 or ord(char) == 0x7F:
            escaped.append(f"\\0{ord(char):03o}")
        else:
            escaped.append(char)
    return '"' + "".join(escaped) + '"'


def main() -> int:
    try:
        environment = sys.argv[1]
        parameters = json.load(sys.stdin)
        if not isinstance(parameters, list) or not parameters:
            raise ValueError

        prefix = f"/agrawal/{environment}/"
        entries = []
        has_web_origins = False
        for parameter in parameters:
            if not isinstance(parameter, list) or len(parameter) != 2:
                raise ValueError
            name, value = parameter
            if not isinstance(name, str) or not name.startswith(prefix):
                raise ValueError
            variable = name[len(prefix) :]
            if not ENV_NAME.fullmatch(variable) or not isinstance(value, str):
                raise ValueError
            if variable == "WEB_ORIGINS" and any(
                origin.strip() for origin in value.split(",")
            ):
                has_web_origins = True
            entries.append(f"{variable}={compose_value(value)}\n")

        if environment in {"staging", "production"} and not has_web_origins:
            print(
                "CRITICAL ERROR: Required SSM parameter WEB_ORIGINS is missing or empty.",
                file=sys.stderr,
            )
            return 1

        sys.stdout.writelines(entries)
    except (IndexError, json.JSONDecodeError, OSError, TypeError, ValueError):
        print("CRITICAL ERROR: Could not serialize AWS SSM parameters.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
