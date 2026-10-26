param([string]$Manifest = (Join-Path (Split-Path $PSScriptRoot -Parent) 'build\AndroidManifest-lan.xml'))
$ErrorActionPreference = 'Stop'
function Assert-QuestLanManifest([xml]$Document) {
    $android = 'http://schemas.android.com/apk/res/android'
    $ns = New-Object Xml.XmlNamespaceManager($Document.NameTable)
    $ns.AddNamespace('a', $android)
    $ns.AddNamespace('m', 'http://schemas.meta.com/metavr-sdk')
    $capture = $Document.SelectSingleNode('/manifest/application/activity[@a:name="android.app.NativeActivity"]', $ns)
    $panel = $Document.SelectSingleNode('/manifest/application/activity[@a:name="dev.quest.usbforwarder.PairingActivity"]', $ns)
    if (!$capture -or !$panel) { throw 'Both capture and setup activities are required' }
    $categories = @($capture.SelectNodes('intent-filter/category', $ns) | ForEach-Object { $_.GetAttribute('name', $android) })
    foreach ($required in @('com.oculus.intent.category.VR', 'org.khronos.openxr.intent.category.IMMERSIVE_HMD', 'android.intent.category.DEFAULT')) {
        if ($categories -notcontains $required) { throw 'Capture requires manifest VR/OpenXR classification' }
    }
    if ($capture.GetAttribute('exported', $android) -ne 'false') { throw 'Capture must remain private to this app' }
    if ($capture.GetAttribute('resizeableActivity', $android) -ne 'false' -or $capture.GetAttribute('screenOrientation', $android) -ne 'landscape') { throw 'Capture must use non-resizable landscape presentation' }
    if (!$capture.GetAttribute('taskAffinity', $android) -or $capture.GetAttribute('taskAffinity', $android) -eq $panel.GetAttribute('taskAffinity', $android)) { throw 'Setup and capture require separate task affinities' }
    $panelCategories = @($panel.SelectNodes('intent-filter/category', $ns) | ForEach-Object { $_.GetAttribute('name', $android) })
    if ($panelCategories -notcontains 'com.oculus.intent.category.2D' -or $panelCategories -notcontains 'android.intent.category.LAUNCHER') { throw 'Setup requires panel classification and a launcher' }
    if (!$Document.SelectSingleNode('/manifest/m:uses-metavr-sdk[@m:minSdkVersion="69"]', $ns)) { throw 'Hybrid activity support must be declared' }
}
[xml]$document = Get-Content -LiteralPath $Manifest -Raw
Assert-QuestLanManifest $document
foreach ($damage in @('vr', 'export', 'task')) {
    [xml]$broken = $document.OuterXml
    $native = @($broken.manifest.application.activity | Where-Object { $_.GetAttribute('name', 'http://schemas.android.com/apk/res/android') -eq 'android.app.NativeActivity' })[0]
    if ($damage -eq 'vr') {
        foreach ($category in @($native.'intent-filter'.category)) {
            if ($category.GetAttribute('name', 'http://schemas.android.com/apk/res/android') -eq 'com.oculus.intent.category.VR') { $native.'intent-filter'.RemoveChild($category) | Out-Null }
        }
    } elseif ($damage -eq 'export') { $native.SetAttribute('exported', 'http://schemas.android.com/apk/res/android', 'true') | Out-Null }
    else {
        $setup = @($broken.manifest.application.activity | Where-Object { $_.GetAttribute('name', 'http://schemas.android.com/apk/res/android') -eq 'dev.quest.usbforwarder.PairingActivity' })[0]
        $native.SetAttribute('taskAffinity', 'http://schemas.android.com/apk/res/android', $setup.GetAttribute('taskAffinity', 'http://schemas.android.com/apk/res/android')) | Out-Null
    }
    $rejected = $false
    try { Assert-QuestLanManifest $broken } catch { $rejected = $true }
    if (!$rejected) { throw "Manifest regression guard missed $damage" }
}
Write-Host 'LAN manifest guard passed: VR classification, private capture, separate tasks; damaged fixtures rejected.'
