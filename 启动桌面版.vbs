Dim shell, fso, projectRoot, command, electronPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectRoot
electronPath = projectRoot & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electronPath) Then
  MsgBox "The desktop runtime is missing. Run the debug .cmd launcher in this folder first.", vbCritical, "BOSS Job Agent"
  WScript.Quit 1
End If
command = Chr(34) & electronPath & Chr(34) & " " & Chr(34) & projectRoot & Chr(34)
shell.Run command, 1, False
