package com.ahoo.abs.android;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.DnsResolver;
import android.net.InetAddresses;
import android.net.Network;
import android.os.CancellationSignal;
import java.net.InetAddress;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Resolves only the explicitly configured proxy endpoint, never the GeoIP destination. */
final class ProxyHostResolver {
    private ProxyHostResolver() { }

    static InetAddress resolve(Context context, String host) throws ProxyGeoProbe.ProbeException {
        if (InetAddresses.isNumericAddress(host)) return InetAddresses.parseNumericAddress(host);
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        Network network = connectivity == null ? null : connectivity.getActiveNetwork();
        if (network == null) throw new ProxyGeoProbe.ProbeException("GEO_NETWORK_UNAVAILABLE");
        CompletableFuture<List<InetAddress>> result = new CompletableFuture<>();
        CancellationSignal cancellation = new CancellationSignal();
        try {
            DnsResolver.getInstance().query(network, host, DnsResolver.FLAG_EMPTY, Runnable::run,
                    cancellation, new DnsResolver.Callback<List<InetAddress>>() {
                        @Override public void onAnswer(List<InetAddress> answer, int code) {
                            if (code == 0 && answer != null && !answer.isEmpty()) result.complete(answer);
                            else result.completeExceptionally(new IllegalStateException("PROXY_DNS_FAILED"));
                        }
                        @Override public void onError(DnsResolver.DnsException error) {
                            result.completeExceptionally(new IllegalStateException("PROXY_DNS_FAILED"));
                        }
                    });
            InetAddress address = result.get(3, TimeUnit.SECONDS).get(0);
            if (address == null) throw new ProxyGeoProbe.ProbeException("GEO_PROXY_DNS_FAILED");
            return address;
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
            throw new ProxyGeoProbe.ProbeException("GEO_CANCELLED_OR_EXPIRED");
        } catch (ExecutionException | TimeoutException | RuntimeException failure) {
            throw new ProxyGeoProbe.ProbeException("GEO_PROXY_DNS_FAILED");
        } finally {
            cancellation.cancel();
        }
    }
}
