package android.util;

import android.os.Looper;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Host boundary, not an Android AtomicFile replacement. Real local files/streams/fsync,
 * isolated fixture roots, explicit backup recovery and controllable commit failures.
 * Every storage API asserts that actual production calls are off the host main thread.
 */
public final class AtomicFile {
    public static final class Faults {
        public int failStarts;
        public int failWrites;
        public int failReads;
        public int throwFinishes;
        public int rejectFinishes;
        public int growOnReadBytes;
        public int failRollbacks;
    }

    private static final List<Path> ROOTS = new ArrayList<>();
    private static final Map<Path, Faults> FAULTS = new LinkedHashMap<>();
    private static final List<String> EVENTS = new ArrayList<>();
    private final Path base;
    private final Path pending;
    private final Path backup;
    private final Faults faults;

    public AtomicFile(File file) {
        assertWorker("construct");
        base = fixturePath(file.toPath());
        pending = fixturePath(Path.of(base + ".new"));
        backup = fixturePath(Path.of(base + ".bak"));
        faults = faults(file);
        event("construct");
    }

    public static synchronized void registerFixtureRoot(Path root) throws IOException {
        ROOTS.add(root.toRealPath());
    }

    private static synchronized Path fixturePath(Path value) {
        Path path = value.toAbsolutePath().normalize();
        for (Path root : ROOTS) {
            if (path.startsWith(root) && !path.equals(root)) return path;
        }
        throw new AssertionError("Refuse host fixture operation outside registered root: " + path);
    }

    public static synchronized Faults faults(File file) {
        return FAULTS.computeIfAbsent(fixturePath(file.toPath()), ignored -> new Faults());
    }

    private static void assertWorker(String operation) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new AssertionError("PRODUCTION DISK I/O ON MAIN: " + operation);
        }
    }

    private void event(String operation) {
        assertWorker(operation);
        synchronized (AtomicFile.class) {
            EVENTS.add(base + "|" + operation + "|" + Thread.currentThread().getName());
        }
    }

    public static synchronized int count(File file, String operation) {
        String prefix = fixturePath(file.toPath()) + "|" + operation + "|";
        int count = 0;
        for (String event : EVENTS) if (event.startsWith(prefix)) count++;
        return count;
    }

    public static synchronized List<String> events(File file) {
        String prefix = fixturePath(file.toPath()) + "|";
        List<String> events = new ArrayList<>();
        for (String event : EVENTS) if (event.startsWith(prefix)) events.add(event);
        return events;
    }

    public FileInputStream openRead() throws IOException {
        event("openRead");
        if (faults.failReads > 0) {
            faults.failReads--;
            throw new IOException("injected read failure");
        }
        if (Files.exists(backup)) {
            // Both paths were normalized/checked against an isolated fixture root above.
            Files.move(backup, base, StandardCopyOption.REPLACE_EXISTING);
            event("recoverBackup");
        }
        return new FileInputStream(base.toFile()) {
            @Override
            public int read(byte[] bytes) throws IOException {
                event("read");
                if (faults.growOnReadBytes > 0) {
                    int growth = faults.growOnReadBytes;
                    faults.growOnReadBytes = 0;
                    try (FileOutputStream append = new FileOutputStream(base.toFile(), true)) {
                        append.write(new byte[growth]);
                    }
                }
                return super.read(bytes);
            }

            @Override
            public void close() throws IOException {
                event("closeRead");
                super.close();
            }
        };
    }

    public FileOutputStream startWrite() throws IOException {
        event("startWrite");
        if (faults.failStarts > 0) {
            faults.failStarts--;
            throw new IOException("injected start failure");
        }
        Files.createDirectories(base.getParent());
        return new FileOutputStream(pending.toFile()) {
            @Override
            public void write(byte[] bytes) throws IOException {
                event("write");
                if (faults.failWrites > 0) {
                    faults.failWrites--;
                    // A genuine partial write must never replace the committed base file.
                    super.write(bytes, 0, Math.min(7, bytes.length));
                    throw new IOException("injected partial write failure");
                }
                super.write(bytes);
            }

            @Override
            public void close() throws IOException {
                event("closeWrite");
                super.close();
            }
        };
    }

    public void finishWrite(FileOutputStream stream) {
        event("finishWrite");
        if (faults.throwFinishes > 0) {
            faults.throwFinishes--;
            throw new IllegalStateException("injected finish failure");
        }
        try {
            stream.close();
            if (faults.rejectFinishes > 0) {
                faults.rejectFinishes--;
                Files.deleteIfExists(pending);
                return; // Deliberately matches Android's nonthrowing error possibility.
            }
            Files.move(pending, base, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException failure) {
            throw new IllegalStateException(failure);
        }
    }

    public void failWrite(FileOutputStream stream) {
        event("failWrite");
        try {
            stream.close();
            Files.deleteIfExists(pending);
        } catch (IOException failure) {
            throw new IllegalStateException(failure);
        }
        if (faults.failRollbacks > 0) {
            faults.failRollbacks--;
            throw new IllegalStateException("injected rollback failure");
        }
    }
}
