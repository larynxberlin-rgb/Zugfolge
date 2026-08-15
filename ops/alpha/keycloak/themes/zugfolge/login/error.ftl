<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    Anmeldung nicht möglich
  <#elseif section = "form">
    <div class="zf-auth-error" role="alert">
      <p class="zf-eyebrow">ZUGFOLGE · ANMELDUNG</p>
      <h1>Die Anmeldung konnte nicht abgeschlossen werden</h1>
      <p>${kcSanitize(message.summary)?no_esc}</p>
      <p class="zf-auth-help">Ihre Eingaben in Zugfolge bleiben in diesem Browser erhalten. Versuchen Sie die Anmeldung erneut oder kehren Sie zur Spielwelt zurück.</p>
      <div class="zf-auth-actions">
        <#if url.loginRestartFlowUrl?has_content>
          <a class="pf-v5-c-button pf-m-primary" href="${url.loginRestartFlowUrl}">Erneut anmelden</a>
        </#if>
        <#if client?? && client.baseUrl?has_content>
          <a class="pf-v5-c-button pf-m-secondary" href="${client.baseUrl}">Zurück zu Zugfolge</a>
        </#if>
      </div>
      <details><summary>Hilfe zur Anmeldung</summary><p>Falls der Fehler erneut auftritt, notieren Sie Uhrzeit und aufgerufene Oberfläche. Zugangscodes oder Tokens gehören nicht in eine Meldung.</p></details>
    </div>
  </#if>
</@layout.registrationLayout>
