package uk.nickward.sara.sensor

import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * Is this Bluetooth address Nick's Watch?
 *
 * The Watch never advertises a fixed address. It uses a Resolvable Private Address
 * that rotates every few minutes, and only the IRK can match one back to the device:
 * the top three bytes are `prand` (top two bits 01), the bottom three are
 * `ah(IRK, prand)` = the low 24 bits of AES-128(IRK, 13 zero bytes || prand).
 *
 * ⚠ BYTE-FOR-BYTE THE SAME RULE AS THE PI AND WINDOWS SENSORS
 * (`bluetooth_data_tools.resolve_private_address`, inlined in
 * windows-watch-lock/watch-presence-reporter.py): the IRK hex is used AS GIVEN as the
 * AES key, and the address string is read most-significant byte first. The same hex
 * that works in `/etc/sara-watch.env` works here. Reversing either is the obvious
 * "fix" to try when nothing matches, and it is wrong — check Location is on first.
 *
 * PURE: no Android APIs, so it pins on the JVM.
 */
class Rpa(irk: ByteArray) {
    init {
        require(irk.size == 16) { "an IRK is 16 bytes (32 hex characters)" }
    }

    private val cipher: Cipher = Cipher.getInstance("AES/ECB/NoPadding").apply {
        init(Cipher.ENCRYPT_MODE, SecretKeySpec(irk, "AES"))
    }

    /** Scan callbacks arrive on binder threads; a Cipher is not thread-safe. */
    @Synchronized
    fun matches(address: String?): Boolean {
        val rpa = parseAddress(address) ?: return false
        if (rpa[0].toInt() and 0xC0 != 0x40) return false   // not a resolvable private address
        val block = ByteArray(16)
        System.arraycopy(rpa, 0, block, 13, 3)
        val ct = cipher.doFinal(block)
        return MessageDigest.isEqual(ct.copyOfRange(13, 16), rpa.copyOfRange(3, 6))
    }

    companion object {
        /** Null for anything that is not exactly 32 hex characters. Never echoes the input. */
        fun fromHex(hex: String?): Rpa? {
            val bytes = hexToBytes(hex?.trim()?.replace(" ", "") ?: return null) ?: return null
            return if (bytes.size == 16) Rpa(bytes) else null
        }

        fun hexToBytes(hex: String): ByteArray? {
            if (hex.length % 2 != 0) return null
            return try {
                ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
            } catch (_: NumberFormatException) {
                null
            }
        }

        fun parseAddress(address: String?): ByteArray? {
            val clean = address?.replace(":", "") ?: return null
            if (clean.length != 12) return null
            return hexToBytes(clean)
        }
    }
}
