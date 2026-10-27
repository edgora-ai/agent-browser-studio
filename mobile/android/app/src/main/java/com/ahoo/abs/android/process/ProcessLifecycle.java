package com.ahoo.abs.android.process;

import android.app.Application;
import android.content.Context;
import android.os.Process;
import android.system.Os;
import android.system.StructStat;
import java.io.File;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;

/** The browser holds its one channel for its entire process lifetime. */
public final class ProcessLifecycle {
    private static final String LIFETIME = "browser-runtime.lck";
    private static final String PUBLICATION = "browser-publication.lck";

    private ProcessLifecycle() { }

    public static Hold holdBrowser(Context context) throws IOException {
        if (!Application.getProcessName().equals(context.getPackageName() + ":browser")) {
            throw new IOException("LIFECYCLE_WRONG_PROCESS");
        }
        return acquire(context, LIFETIME);
    }

    public static Hold holdPublication(Context context) throws IOException {
        requireMain(context);
        return acquire(context, PUBLICATION);
    }

    public static boolean isBrowserLockFree(Context context) throws IOException {
        requireMain(context);
        try (FileChannel channel = open(context, LIFETIME)) {
            FileLock lock;
            try {
                lock = channel.tryLock();
            } catch (OverlappingFileLockException busy) {
                return false;
            }
            if (lock == null) {
                return false;
            }
            lock.release();
            return true;
        }
    }

    private static void requireMain(Context context) throws IOException {
        if (!Application.getProcessName().equals(context.getPackageName())) {
            throw new IOException("LIFECYCLE_CHECK_WRONG_PROCESS");
        }
    }

    private static Hold acquire(Context context, String name) throws IOException {
        FileChannel channel = open(context, name);
        try {
            FileLock lock = channel.tryLock();
            if (lock == null) {
                throw new IOException("BROWSER_PROCESS_BUSY");
            }
            return new Hold(channel, lock);
        } catch (IOException | RuntimeException failure) {
            channel.close();
            throw failure;
        }
    }

    private static FileChannel open(Context context, String name) throws IOException {
        File file = new File(context.getNoBackupFilesDir(), name);
        try {
            if (!file.exists()) {
                boolean created = file.createNewFile();
                if (created) {
                    Os.chmod(file.getAbsolutePath(), 0600);
                }
            }
            StructStat info = Os.lstat(file.getAbsolutePath());
            if (info.st_uid != Process.myUid() || (info.st_mode & 0170000) != 0100000
                    || (info.st_mode & 0077) != 0) {
                throw new IOException("UNSAFE_LIFECYCLE_FILE");
            }
            return FileChannel.open(file.toPath(), StandardOpenOption.READ,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        } catch (android.system.ErrnoException failure) {
            throw new IOException("LIFECYCLE_FILE_IO", failure);
        }
    }

    public static final class Hold implements AutoCloseable {
        private final FileChannel channel;
        private final FileLock lock;

        private Hold(FileChannel channel, FileLock lock) {
            this.channel = channel;
            this.lock = lock;
        }

        @Override
        public void close() throws IOException {
            try {
                lock.release();
            } finally {
                channel.close();
            }
        }
    }
}
