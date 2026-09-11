package uk.nickward.sara.sensor

/**
 * A reading is a flat map of strings, numbers, booleans and nulls. `org.json` exists on
 * the device but is a stub in JVM unit tests, so the one serialiser the push depends on
 * is written here where it can be pinned.
 */
object Json {
    fun encode(map: Map<String, Any?>): String =
        map.entries.joinToString(",", "{", "}") { (k, v) -> quote(k) + ":" + value(v) }

    private fun value(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> v.toString()
        is Int, is Long -> v.toString()
        is Double -> if (v.isFinite()) v.toString() else "null"
        is Number -> v.toString()
        else -> quote(v.toString())
    }

    private fun quote(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> b.append("\\\"")
                c == '\\' -> b.append("\\\\")
                c == '\n' -> b.append("\\n")
                c == '\r' -> b.append("\\r")
                c == '\t' -> b.append("\\t")
                c < ' ' -> b.append(String.format("\\u%04x", c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }
}
