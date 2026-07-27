# El Portal del Cliente

Este documento gobierna toda decisión de diseño y de producto en el portal del cliente
(`/portal/[token]`). Se escribió antes de construir la interfaz, no después — cualquier cambio
futuro al portal debe releerlo primero.

## La pregunta que responde

El portal existe para responder **una sola pregunta**: *¿qué necesito hacer ahora?*

No es un panel. No es una versión reducida del espacio de trabajo del Staff. Es una lista de
tareas para una persona que probablemente está en su teléfono, no quiere aprender el producto, y
solo pasará por aquí un par de veces en su vida.

## El recorrido (client journey)

```
1. Resolver la invitación        — ¿quién me escribe y para qué expediente?
2. Autenticarse con un código     — un correo, un código, sin contraseña
3. Resolver el acceso activo      — ¿sigue vigente mi invitación?
4. Ver qué me falta, primero      — lo pendiente antes que lo ya resuelto
5. Subir documentos               — por URL firmada, nunca a una ruta que yo controle
6. Ver el resultado de la revisión — Aprobado / Rechazado / Pendiente
7. Reemplazar lo rechazado        — un nuevo intento, sin perder el historial
8. Terminar                       — una pantalla de cierre cuando ya no falta nada
```

Cada paso es un estado real de la aplicación, no una pantalla de tránsito. El código roto o
vencido, el acceso revocado, el archivo rechazado: cada uno tiene su propio estado dedicado, nunca
un error genérico.

## Reglas de la experiencia del cliente

Estas reglas no son sugerencias de estilo — son restricciones que cualquier cambio debe respetar:

1. **El cliente nunca ve información de otros participantes.** Ni sus nombres, ni sus documentos,
   ni si ya terminaron. Cada persona ve solo su propia lista.
2. **Siempre se muestran primero las acciones pendientes.** Lo rechazado y lo pendiente van
   arriba; lo aprobado y lo en revisión, abajo y en un tono visual más discreto.
3. **Nunca se usan términos internos.** "Blueprint", "Grant" o "Participant" no existen en la
   pantalla del cliente. Se dice "expediente", "tu acceso", "tu información" — el lenguaje del
   producto, no el del esquema.
4. **Nunca hay más de un CTA principal por pantalla.** Cada pantalla tiene una acción central:
   pedir el código, verificarlo, subir el siguiente documento. Las acciones secundarias (reenviar
   código, volver) son texto, nunca un botón que compita en peso visual.
5. **El cliente siempre sabe qué falta para terminar.** Un contador simple ("te faltan 2 de 4"),
   visible pero nunca protagonista.
6. **El cliente siempre entiende por qué se rechazó algo y cómo resolverlo.** El motivo que
   escribió el Staff se muestra tal cual, junto al botón para volver a subir — nunca oculto detrás
   de un clic adicional.
7. **El progreso es visible, pero nunca más importante que la siguiente acción.** No hay una
   barra de progreso como pieza central (eso es la identidad visual del Staff, no la del
   cliente). Aquí el protagonista es la lista de lo que falta.

## Por qué el portal no se parece al panel del Staff

El panel del Staff está construido alrededor del **progreso** (design.md): una barra royal, un
expediente con múltiples participantes, una vista de conjunto. Eso es correcto para alguien que
gestiona muchos expedientes a la vez.

El cliente gestiona **uno**. Su experiencia entera es una lista de tareas y sus resultados. Si el
portal alguna vez empieza a verse como una versión chica del panel del Staff — con progreso como
héroe, con navegación, con secciones — es una señal de que se rompió este documento.

## Ciclo de vida de la invitación (dominio, no UX)

Modelado como su propio ciclo, separado del acceso ya otorgado:

```
pendiente → enviada → fallida → aceptada → revocada
                                      ↑
                          (vencida se deriva, nunca se guarda)
```

- **pendiente**: se creó la invitación, no se ha enviado ningún código.
- **enviada**: el código salió por correo al menos una vez.
- **fallida**: el envío falló — reintentar es la operación normal, no un caso especial.
- **aceptada**: el cliente verificó su código. A partir de aquí, el acceso mismo (vigencia,
  permiso) lo gobierna el ciclo de vida del *grant*, no el de la invitación.
- **revocada**: el Staff cortó el acceso. Termina cualquier otro estado, incluso "aceptada".
- **vencida**: nunca se escribe en la base — se calcula en el momento de leer, comparando contra
  la fecha límite. Igual que la vigencia del grant en el resto del sistema: ningún trabajo
  programado puede dejar un estado viejo mintiendo en la tabla.
