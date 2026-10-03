$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$watcher = $null
try {
    Add-Type -AssemblyName System.Device
    $watcher = [System.Device.Location.GeoCoordinateWatcher]::new([System.Device.Location.GeoPositionAccuracy]::High)
    # Respect Windows location permissions; never change OS settings or watch in the background.
    $watcher.Start($true)
    $started = [DateTime]::UtcNow
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ($watcher.Position.Location.IsUnknown -and [DateTime]::UtcNow -lt $deadline) {
        if ($watcher.Permission -eq [System.Device.Location.GeoPositionPermission]::Denied) { break }
        if ($watcher.Status -eq [System.Device.Location.GeoPositionStatus]::Disabled -and ([DateTime]::UtcNow - $started).TotalSeconds -ge 2) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($watcher.Permission -eq [System.Device.Location.GeoPositionPermission]::Denied) {
        @{ success = $false; code = 'permission_denied' } | ConvertTo-Json -Compress
    } elseif ($watcher.Position.Location.IsUnknown) {
        @{ success = $false; code = 'unavailable' } | ConvertTo-Json -Compress
    } else {
        $point = $watcher.Position.Location
        $accuracy = if ([Double]::IsNaN($point.HorizontalAccuracy)) { $null } else { $point.HorizontalAccuracy }
        @{ success = $true; longitude = $point.Longitude; latitude = $point.Latitude;
           accuracyMeters = $accuracy; timestamp = $watcher.Position.Timestamp.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    }
} catch {
    @{ success = $false; code = 'unavailable' } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $watcher) { $watcher.Stop(); $watcher.Dispose() }
}
