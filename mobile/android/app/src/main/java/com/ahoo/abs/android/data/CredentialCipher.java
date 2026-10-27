package com.ahoo.abs.android.data;

import android.database.sqlite.SQLiteDatabase;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only runs inside this new Android app. No key export, deletion, software key or fallback. */
final class CredentialCipher {
    static final class Envelope {
        final byte[] iv;
        final byte[] ciphertext;

        Envelope(byte[] iv, byte[] ciphertext) {
            this.iv = iv;
            this.ciphertext = ciphertext;
        }
    }

    private final String storeId;
    private final String alias;

    CredentialCipher(String storeId) {
        if (storeId == null || !storeId.matches("[0-9a-f]{32}")) {
            throw new StorageException(StorageException.Code.INTEGRITY_FAILURE);
        }
        this.storeId = storeId;
        alias = "com.ahoo.abs.android.profiles.aesgcm.v1." + storeId;
    }

    Envelope encrypt(SQLiteDatabase db, String id, String revision, char[] user, char[] pass) {
        byte[] plaintext = encode(user, pass);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(db, true));
            cipher.updateAAD(aad(id, revision));
            byte[] encrypted = cipher.doFinal(plaintext);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != 12) unavailable();
            return new Envelope(iv, encrypted);
        } catch (GeneralSecurityException | RuntimeException exception) {
            throw new StorageException(StorageException.Code.CRYPTO_UNAVAILABLE);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    Credentials decrypt(SQLiteDatabase db, String id, String revision, Envelope envelope) {
        byte[] plaintext = null;
        try {
            if (envelope.iv.length != 12 || envelope.ciphertext.length < 30
                    || envelope.ciphertext.length > 32800) unavailable();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(db, false),
                    new GCMParameterSpec(128, envelope.iv));
            cipher.updateAAD(aad(id, revision));
            plaintext = cipher.doFinal(envelope.ciphertext);
            return decode(plaintext);
        } catch (GeneralSecurityException | RuntimeException exception) {
            throw new StorageException(StorageException.Code.CREDENTIALS_UNAVAILABLE);
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    private SecretKey key(SQLiteDatabase db, boolean mayCreate) throws GeneralSecurityException {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (!keyStore.containsAlias(alias)) {
                if (!mayCreate || hasEnvelopes(db)) unavailable();
                KeyGenerator generator = KeyGenerator.getInstance(
                        KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(alias,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setKeySize(256)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true)
                        .build());
                generator.generateKey();
            }
            Key handle = keyStore.getKey(alias, null);
            if (!(handle instanceof SecretKey)) unavailable();
            return (SecretKey) handle;
        } catch (IOException exception) {
            throw new StorageException(StorageException.Code.CRYPTO_UNAVAILABLE);
        }
    }

    private static boolean hasEnvelopes(SQLiteDatabase db) {
        try (android.database.Cursor cursor = db.rawQuery(
                "SELECT 1 FROM credential_envelopes LIMIT 1", null)) {
            return cursor.moveToFirst();
        }
    }

    private byte[] aad(String id, String revision) {
        StoreChecks.uuid(id);
        StoreChecks.uuid(revision);
        return ("abs.credentials.v1\n" + storeId + "\n" + id + "\n" + revision)
                .getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] encode(char[] user, char[] pass) {
        ByteBuffer userBytes = null;
        ByteBuffer passBytes = null;
        try {
            userBytes = encodeChars(user);
            passBytes = encodeChars(pass);
            ByteBuffer output = ByteBuffer.allocate(12 + userBytes.remaining() + passBytes.remaining());
            output.putInt(1).putInt(userBytes.remaining()).put(userBytes);
            output.putInt(passBytes.remaining()).put(passBytes);
            return output.array();
        } catch (CharacterCodingException exception) {
            throw new StorageException(StorageException.Code.CREDENTIAL_UPDATE_INVALID);
        } finally {
            wipe(userBytes);
            wipe(passBytes);
        }
    }

    private static ByteBuffer encodeChars(char[] value) throws CharacterCodingException {
        return StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(value));
    }

    private static Credentials decode(byte[] plaintext) {
        char[] user = null;
        char[] pass = null;
        try {
            ByteBuffer input = ByteBuffer.wrap(plaintext);
            if (input.remaining() < 14 || input.getInt() != 1) unavailable();
            user = readChars(input);
            pass = readChars(input);
            if (input.hasRemaining()) unavailable();
            Credentials result = new Credentials(user, pass);
            user = null;
            pass = null;
            return result;
        } catch (CharacterCodingException | java.nio.BufferUnderflowException exception) {
            throw new StorageException(StorageException.Code.CREDENTIALS_UNAVAILABLE);
        } finally {
            if (user != null) Arrays.fill(user, '\0');
            if (pass != null) Arrays.fill(pass, '\0');
        }
    }

    private static char[] readChars(ByteBuffer input) throws CharacterCodingException {
        int length = input.getInt();
        if (length < 1 || length > 16384 || length > input.remaining()) unavailable();
        ByteBuffer slice = input.slice();
        slice.limit(length);
        CharBuffer decoded = null;
        try {
            decoded = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(slice);
            if (decoded.remaining() < 1 || decoded.remaining() > 4096) unavailable();
            char[] result = new char[decoded.remaining()];
            decoded.get(result);
            input.position(input.position() + length);
            return result;
        } finally {
            if (decoded != null && decoded.hasArray()) Arrays.fill(decoded.array(), '\0');
        }
    }

    private static void wipe(ByteBuffer bytes) {
        if (bytes != null && bytes.hasArray()) Arrays.fill(bytes.array(), (byte) 0);
    }

    private static void unavailable() {
        throw new StorageException(StorageException.Code.CREDENTIALS_UNAVAILABLE);
    }
}
