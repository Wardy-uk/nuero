package uk.nickward.sara.sensor

/**
 * The greeting sara/backend hands over in the reply to a reading:
 *   {"ok":true,"room":"study","greeting":{"id":"...","text":"Morning, Nick."}}
 *
 * PURE and dependency-free (org.json is a stub in JVM unit tests), so the one parse
 * that decides whether SARA speaks is pinned. Anything malformed is null — silence,
 * never a garbled sentence read aloud.
 */
data class Greeting(val id: String, val text: String) {
    companion object {
        private val OBJECT = Regex("\"greeting\"\\s*:\\s*\\{([^{}]*)\\}")
        private fun field(name: String) = Regex("\"$name\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")

        fun parse(body: String?): Greeting? {
            if (body.isNullOrEmpty()) return null
            val inner = OBJECT.find(body)?.groupValues?.get(1) ?: return null
            val id = field("id").find(inner)?.groupValues?.get(1)?.let(::unescape) ?: return null
            val text = field("text").find(inner)?.groupValues?.get(1)?.let(::unescape)?.trim() ?: return null
            if (id.isEmpty() || text.isEmpty() || text.length > 500) return null
            return Greeting(id, text)
        }

        private fun unescape(s: String): String {
            val b = StringBuilder()
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c != '\\' || i + 1 >= s.length) { b.append(c); i++; continue }
                val n = s[i + 1]
                when (n) {
                    'n' -> b.append('\n')
                    't' -> b.append('\t')
                    'r' -> b.append('\r')
                    'u' -> {
                        if (i + 5 < s.length) {
                            b.append(s.substring(i + 2, i + 6).toIntOrNull(16)?.toChar() ?: '?')
                            i += 4
                        }
                    }
                    else -> b.append(n)
                }
                i += 2
            }
            return b.toString()
        }
    }
}
