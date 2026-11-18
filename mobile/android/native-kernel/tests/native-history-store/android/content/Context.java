package android.content;

import java.io.File;

/** Minimal host boundary, not an Android Context implementation. */
public abstract class Context {
    public abstract Context getApplicationContext();
    public abstract File getNoBackupFilesDir();
}
