export function redactId(value: unknown, visible = 8): string {
  if (value === null || value === undefined) return "null"
  const text = String(value)
  if (text.length <= visible) return `${text}...`
  return `${text.slice(0, visible)}...`
}

export function logInfo(message: string, data?: Record<string, unknown>) {
  if (data) {
    console.log(JSON.stringify({ level: "info", message, ...data }))
    return
  }
  console.log(JSON.stringify({ level: "info", message }))
}

export function logWarn(message: string, data?: Record<string, unknown>) {
  if (data) {
    console.warn(JSON.stringify({ level: "warn", message, ...data }))
    return
  }
  console.warn(JSON.stringify({ level: "warn", message }))
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240)
  return "Unknown error"
}

