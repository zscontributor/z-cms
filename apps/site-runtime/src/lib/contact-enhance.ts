import { CONTACT_FORM_FIELDS, toClientRules } from "@zcmsorg/schemas";

/**
 * Progressive enhancement for the contact form — the runtime's job, not the
 * theme's (themes ship no client JS, and the runtime owns `/api/contact/submit`).
 *
 * Two upgrades over the plain POST/redirect fallback:
 *
 *   - **Validation from the SHARED form schema.** The field rules come from
 *     `CONTACT_FORM_FIELDS` in `@zcmsorg/schemas` — the very list cms-api validates
 *     with (via `buildFormSchema`). `toClientRules` projects them to plain JSON the
 *     inline script interprets, so the browser rejects the same things the server
 *     does (e.g. `aa@aa`, which HTML `type="email"` wrongly accepts) with an
 *     inline message, BEFORE anything is sent. One declaration, no client/server
 *     drift — the general fix, not a per-field hack.
 *   - **Submit over fetch, no navigation.** On failure the fields stay exactly as
 *     typed and the error banner shows; on success the form is reset and the
 *     success banner shows. The form is only ever cleared on a real success.
 *
 * Scoped to forms posting to the contact endpoint the runtime itself defines.
 */
const CONTACT_ENDPOINT = "/api/contact/submit";

export function contactEnhanceScript(): string {
  const rules = JSON.stringify(toClientRules(CONTACT_FORM_FIELDS));
  // Static apart from the schema-derived rules (JSON) — safe to inline under the
  // CSP nonce.
  return `(function(){
  var EP=${JSON.stringify(CONTACT_ENDPOINT)};
  var RULES=${rules};
  var EMAIL=/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;
  var URLRE=/^https?:\\/\\/[^\\s]+$/i;
  var M={
    en:{email:"Please enter a valid email address, e.g. name@example.com.",url:"Please enter a valid URL starting with http:// or https://.",pattern:"This value is not in the expected format.",min:function(n){return "Please use at least "+n+" characters.";},max:function(n){return "Please use at most "+n+" characters.";}},
    vi:{email:"Vui lòng nhập email hợp lệ, ví dụ: ten@example.com.",url:"Vui lòng nhập URL hợp lệ bắt đầu bằng http:// hoặc https://.",pattern:"Giá trị không đúng định dạng.",min:function(n){return "Vui lòng nhập tối thiểu "+n+" ký tự.";},max:function(n){return "Vui lòng nhập tối đa "+n+" ký tự.";}},
    ja:{email:"有効なメールアドレスを入力してください（例: name@example.com）。",url:"http:// または https:// で始まる有効なURLを入力してください。",pattern:"形式が正しくありません。",min:function(n){return n+"文字以上で入力してください。";},max:function(n){return n+"文字以内で入力してください。";}}
  };
  function dict(){return M[(document.documentElement.lang||"en").slice(0,2)]||M.en;}
  function violation(rule,val){
    if(!val)return ""; // empty is the "required" attribute's job
    var d=dict();
    if(rule.type==="email"&&!EMAIL.test(val))return d.email;
    if(rule.type==="url"&&!URLRE.test(val))return d.url;
    if(rule.pattern){try{if(!new RegExp(rule.pattern).test(val))return d.pattern;}catch(e){}}
    if(rule.minLength!=null&&val.length<rule.minLength)return d.min(rule.minLength);
    if(rule.maxLength!=null&&val.length>rule.maxLength)return d.max(rule.maxLength);
    return "";
  }
  function show(id){
    var el=document.getElementById(id); if(!el)return;
    if(!el.hasAttribute("data-revealed"))el.setAttribute("data-revealed","");
    var sid="__reveal-"+id;
    if(!document.getElementById(sid)){var s=document.createElement("style");s.id=sid;s.textContent="#"+id+"{display:block !important}";document.head.appendChild(s);}
    try{el.scrollIntoView({block:"center"});}catch(e){}
  }
  function hide(id){
    var el=document.getElementById(id); if(el)el.removeAttribute("data-revealed");
    var s=document.getElementById("__reveal-"+id); if(s&&s.parentNode)s.parentNode.removeChild(s);
  }
  function enhance(form){
    if(form.__cEnh)return; form.__cEnh=true;
    RULES.forEach(function(rule){
      var el=form.elements[rule.name];
      if(!el||typeof el.setCustomValidity!=="function")return; // skip radio groups etc
      var chk=function(){ el.setCustomValidity(violation(rule,(el.value||"").trim())); };
      el.addEventListener("input",chk); el.addEventListener("change",chk); el.addEventListener("blur",chk);
      chk();
    });
    form.addEventListener("submit",function(ev){
      // The submit event only fires once native validation (required + our custom
      // messages) has passed, so the form is valid here; guard anyway.
      if(typeof form.checkValidity==="function"&&!form.checkValidity())return;
      ev.preventDefault();
      var btn=form.querySelector('[type="submit"]');
      if(btn)btn.disabled=true;
      hide("contact-sent"); hide("contact-error");
      var body;
      try{body=new URLSearchParams(new FormData(form)).toString();}catch(e){body="";}
      fetch(form.getAttribute("action")||EP,{
        method:"POST",
        headers:{"content-type":"application/x-www-form-urlencoded","accept":"application/json"},
        body:body,
        credentials:"same-origin",
        cache:"no-store"
      })
      .then(function(r){return r.json().then(function(d){return d;},function(){return {ok:r.ok};});})
      .then(function(d){ if(d&&d.ok){ form.reset(); show("contact-sent"); } else { show("contact-error"); } })
      .catch(function(){ show("contact-error"); })
      .then(function(){ if(btn)btn.disabled=false; });
    });
  }
  function init(){
    var forms=document.querySelectorAll('form[action="'+EP+'"]');
    for(var i=0;i<forms.length;i++)enhance(forms[i]);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);
  else init();
})();`;
}
